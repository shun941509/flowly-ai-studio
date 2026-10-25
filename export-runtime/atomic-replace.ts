import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

type ReplacementIO = {
  platform: NodeJS.Platform;
  rename: (source: string, target: string) => Promise<void>;
  delay: (milliseconds: number) => Promise<unknown>;
};

/** Retry only a denied atomic replacement, never the operation recorded in it. */
export async function replaceStateFile(source: string, target: string, assertLock: () => Promise<void>, io: ReplacementIO = { platform: process.platform, rename, delay }): Promise<void> {
  const waits = [20, 40, 80, 160, 320];
  for (let attempt = 0; ; attempt++) {
    await assertLock();
    try { await io.rename(source, target); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (io.platform !== "win32" || !["EPERM", "EBUSY"].includes(code ?? "") || attempt >= waits.length) throw error;
      // The temporary bytes are unchanged; a lost lock aborts before another try.
      await io.delay(waits[attempt]);
    }
  }
}
