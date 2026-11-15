import type { TrafficCountMode } from "./types";

export type TrafficLedgerRow = {
  cycle_key: string;
  last_agent_rx: number;
  last_agent_tx: number;
  cycle_rx_bytes: number;
  cycle_tx_bytes: number;
  updated_at: number;
};

function daysInUtcMonth(year: number, monthZeroBased: number): number {
  return new Date(Date.UTC(year, monthZeroBased + 1, 0)).getUTCDate();
}

export function computeTrafficCycle(
  tsSec: number,
  resetDay: number,
): { cycleKey: string; daysRemaining: number } {
  const safeResetDay = Math.min(31, Math.max(1, Math.floor(resetDay || 1)));
  const now = new Date(tsSec * 1000);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  const effectiveThisMonth = Math.min(safeResetDay, daysInUtcMonth(year, month));

  let startYear: number;
  let startMonth: number;
  let nextYear: number;
  let nextMonth: number;
  let nextDay: number;

  if (day < effectiveThisMonth) {
    startYear = month === 0 ? year - 1 : year;
    startMonth = month === 0 ? 11 : month - 1;
    nextYear = year;
    nextMonth = month;
    nextDay = effectiveThisMonth;
  } else {
    startYear = year;
    startMonth = month;
    nextYear = month === 11 ? year + 1 : year;
    nextMonth = month === 11 ? 0 : month + 1;
    nextDay = Math.min(safeResetDay, daysInUtcMonth(nextYear, nextMonth));
  }

  const cycleKey = `${startYear}-${String(startMonth + 1).padStart(2, "0")}`;
  const nextResetTs = Math.floor(Date.UTC(nextYear, nextMonth, nextDay) / 1000);
  const daysRemaining = Math.max(0, Math.ceil((nextResetTs - tsSec) / 86400));

  return { cycleKey, daysRemaining };
}

export function computeCountedBytes(
  rxBytes: number,
  txBytes: number,
  mode: TrafficCountMode,
): number {
  switch (mode) {
    case "tx_only":
      return txBytes;
    case "max":
      return Math.max(rxBytes, txBytes);
    case "both":
    default:
      return rxBytes + txBytes;
  }
}

export function advanceTrafficLedger(
  prev: TrafficLedgerRow | null,
  agentRxTot: number,
  agentTxTot: number,
  tsSec: number,
  resetDay: number,
): { next: TrafficLedgerRow; rebooted: boolean; cycleReset: boolean } {
  const rxTot = Math.max(0, Math.floor(agentRxTot));
  const txTot = Math.max(0, Math.floor(agentTxTot));
  const { cycleKey } = computeTrafficCycle(tsSec, resetDay);

  if (!prev) {
    return {
      next: {
        cycle_key: cycleKey,
        last_agent_rx: rxTot,
        last_agent_tx: txTot,
        cycle_rx_bytes: 0,
        cycle_tx_bytes: 0,
        updated_at: tsSec,
      },
      rebooted: false,
      cycleReset: false,
    };
  }

  const rxRebooted = rxTot < prev.last_agent_rx;
  const txRebooted = txTot < prev.last_agent_tx;
  const rebooted = rxRebooted || txRebooted;

  const deltaRx = rxRebooted ? rxTot : rxTot - prev.last_agent_rx;
  const deltaTx = txRebooted ? txTot : txTot - prev.last_agent_tx;

  const cycleReset = prev.cycle_key !== cycleKey;
  const baseRx = cycleReset ? 0 : prev.cycle_rx_bytes;
  const baseTx = cycleReset ? 0 : prev.cycle_tx_bytes;

  return {
    next: {
      cycle_key: cycleKey,
      last_agent_rx: rxTot,
      last_agent_tx: txTot,
      cycle_rx_bytes: baseRx + deltaRx,
      cycle_tx_bytes: baseTx + deltaTx,
      updated_at: tsSec,
    },
    rebooted,
    cycleReset,
  };
}
