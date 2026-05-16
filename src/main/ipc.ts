import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { isAllowedOrigin } from "./security.js";

// DS3 contract: every IPC channel registered through this router
// validates `event.senderFrame.url` against the discovered server
// URL and fails closed on mismatch. Channels are not raw strings —
// callers must declare the channel name in `IpcChannelName` (see
// shared/ipc-types.ts) so the registry stays under the 40-channel cap
// in Control Plan Rule 5 and so adding a channel is a typed contract
// change rather than a silent string drop.

export class IpcOriginRejection extends Error {
  readonly channel: string;
  readonly senderUrl: string;

  constructor(channel: string, senderUrl: string) {
    super(
      `IPC channel "${channel}" rejected: senderFrame URL "${senderUrl}" does not match the allowed origin`,
    );
    this.name = "IpcOriginRejection";
    this.channel = channel;
    this.senderUrl = senderUrl;
  }
}

export type IpcHandler<TPayload, TResult> = (
  event: IpcMainInvokeEvent,
  payload: TPayload,
) => TResult | Promise<TResult>;

export interface IpcRouterOptions {
  readonly allowedOrigin: string;
  readonly ipc: Pick<IpcMain, "handle">;
  readonly logger?: (message: string) => void;
}

export interface IpcRouter {
  register<TPayload, TResult>(
    channel: string,
    handler: IpcHandler<TPayload, TResult>,
  ): void;
}

export function createIpcRouter(opts: IpcRouterOptions): IpcRouter {
  return {
    register<TPayload, TResult>(
      channel: string,
      handler: IpcHandler<TPayload, TResult>,
    ): void {
      opts.ipc.handle(channel, async (event, payload: TPayload) => {
        const senderUrl = event.senderFrame?.url ?? "";
        if (!isAllowedOrigin(senderUrl, opts.allowedOrigin)) {
          const rejection = new IpcOriginRejection(channel, senderUrl);
          opts.logger?.(rejection.message);
          throw rejection;
        }
        return handler(event, payload);
      });
    },
  };
}
