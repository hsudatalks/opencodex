import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  beginShutdownDrain,
  codexAccountCapacityQueueMetrics,
  MAX_QUEUED_CODEX_ACCOUNT_TURNS,
  resetLifecycleDrainStateForTests,
  tryAdmitTurn,
} from "../src/server/lifecycle";

describe("Codex account concurrent turn admission", () => {
  beforeEach(() => resetLifecycleDrainStateForTests());
  afterEach(() => resetLifecycleDrainStateForTests());

  test("caps active turns per account and releases capacity with the turn", () => {
    const first = tryAdmitTurn()!;
    const second = tryAdmitTurn()!;
    const firstSelection = first.beginCodexAccountSelection();
    const secondSelection = second.beginCodexAccountSelection();

    expect(firstSelection.claimAccount("pool-a", 1)).toBeTrue();
    expect(firstSelection.canClaimAccount("pool-a", 1)).toBeTrue();
    expect(secondSelection.canClaimAccount("pool-a", 1)).toBeFalse();
    expect(secondSelection.claimAccount("pool-a", 1)).toBeFalse();

    firstSelection.release();
    first.release();

    expect(secondSelection.canClaimAccount("pool-a", 1)).toBeTrue();
    expect(secondSelection.claimAccount("pool-a", 1)).toBeTrue();

    secondSelection.release();
    second.release();
  });

  test("moves one turn claim atomically when an upstream retry changes account", () => {
    const turn = tryAdmitTurn()!;
    const peer = tryAdmitTurn()!;
    const selection = turn.beginCodexAccountSelection();
    const peerSelection = peer.beginCodexAccountSelection();

    expect(selection.claimAccount("pool-a", 1)).toBeTrue();
    expect(selection.claimAccount("pool-b", 1)).toBeTrue();
    expect(peerSelection.claimAccount("pool-a", 1)).toBeTrue();
    expect(peerSelection.claimAccount("pool-b", 1)).toBeFalse();

    selection.release();
    peerSelection.release();
    turn.release();
    peer.release();
  });

  test("runs only the final account settlement callback when the turn ends", () => {
    const turn = tryAdmitTurn()!;
    const selection = turn.beginCodexAccountSelection();
    const settled: string[] = [];

    expect(selection.claimAccount("pool-a", 2, () => settled.push("a"))).toBeTrue();
    expect(selection.claimAccount("pool-b", 2, () => settled.push("b"))).toBeTrue();
    expect(settled).toEqual([]);

    selection.release();
    expect(settled).toEqual([]);
    turn.release();
    expect(settled).toEqual(["b"]);
  });

  test("queues account saturation and admits the waiter when the owning turn settles", async () => {
    const first = tryAdmitTurn()!;
    const second = tryAdmitTurn()!;
    const owner = first.beginCodexAccountSelection();
    const waiter = second.beginCodexAccountSelection();
    expect(owner.claimAccount("pool-a", 1)).toBeTrue();

    const pending = waiter.waitForCapacity("pool-a");
    expect(codexAccountCapacityQueueMetrics()).toMatchObject({ queued: 1, admitted: 1, peak: 1 });
    first.release();
    await expect(pending).resolves.toBe("capacity_changed");
    expect(waiter.claimAccount("pool-a", 1)).toBeTrue();

    owner.release();
    waiter.release();
    second.release();
  });

  test("cancels a queued wait when its client aborts", async () => {
    const turn = tryAdmitTurn()!;
    const selection = turn.beginCodexAccountSelection();
    const abort = new AbortController();
    const pending = selection.waitForCapacity("pool-a", abort.signal);
    abort.abort();
    await expect(pending).resolves.toBe("aborted");
    expect(codexAccountCapacityQueueMetrics()).toMatchObject({ queued: 0, cancelled: 1 });
    selection.release();
    turn.release();
  });

  test("bounds the waiting queue and rejects overflow without reporting an upstream 429", async () => {
    const turns = Array.from({ length: MAX_QUEUED_CODEX_ACCOUNT_TURNS + 1 }, () => tryAdmitTurn()!);
    const selections = turns.map(turn => turn.beginCodexAccountSelection());
    const pending = selections.slice(0, MAX_QUEUED_CODEX_ACCOUNT_TURNS)
      .map(selection => selection.waitForCapacity("pool-a"));
    await expect(selections.at(-1)!.waitForCapacity("pool-a")).resolves.toBe("queue_full");
    expect(codexAccountCapacityQueueMetrics()).toMatchObject({
      queued: MAX_QUEUED_CODEX_ACCOUNT_TURNS,
      rejected: 1,
    });
    beginShutdownDrain();
    await Promise.all(pending);
    for (const selection of selections) selection.release();
    for (const turn of turns) turn.release();
  });

  test("drains queued waits during shutdown", async () => {
    const turn = tryAdmitTurn()!;
    const selection = turn.beginCodexAccountSelection();
    const pending = selection.waitForCapacity("pool-a");
    beginShutdownDrain();
    await expect(pending).resolves.toBe("draining");
    expect(codexAccountCapacityQueueMetrics().queued).toBe(0);
    selection.release();
    turn.release();
  });
});
