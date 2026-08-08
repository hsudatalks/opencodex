import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
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
});
