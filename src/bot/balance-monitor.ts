import { BalanceMonitor } from "./types";
import { logger } from "./logger";

export type TransferDirection = "in" | "out";

export function createBalanceMonitor(
  registerEventHandler: (handler: (event: any) => Promise<void>) => void,
  getMonitors: () => BalanceMonitor[],
  onTransfer: (wallet: string, mint: string, symbol: string, direction: TransferDirection, amount: number) => Promise<void>,
): void {
  registerEventHandler(async (event: any) => {
    if (event.transactionError) return;
    const transfers: any[] = event.tokenTransfers ?? [];
    const monitors = getMonitors();
    for (const t of transfers) {
      const mint: string | undefined = t.mint;
      if (!mint) continue;
      const toUser: string   = t.toUserAccount   ?? "";
      const fromUser: string = t.fromUserAccount ?? "";
      const amount: number   = t.tokenAmount     ?? 0;
      for (const monitor of monitors) {
        if (monitor.mint !== mint) continue;
        for (const wallet of monitor.wallets) {
          if (toUser === wallet) {
            logger.info("Balance monitor: inflow", { wallet, mint, amount });
            await onTransfer(wallet, mint, monitor.symbol, "in", amount).catch((err) =>
              logger.error("Balance monitor: onTransfer failed", { error: String(err) })
            );
          } else if (fromUser === wallet) {
            logger.info("Balance monitor: outflow", { wallet, mint, amount });
            await onTransfer(wallet, mint, monitor.symbol, "out", amount).catch((err) =>
              logger.error("Balance monitor: onTransfer failed", { error: String(err) })
            );
          }
        }
      }
    }
  });
}
