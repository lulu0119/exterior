import type {
  CodemodeRemoteMessage,
  CodemodeRemoteReply,
  CodemodeRemoteRequest,
} from "@earendil-works/pi-codemode/portable";
import { defineInvokeEventa } from "@moeru/eventa";

export const executeEvent = defineInvokeEventa<void, CodemodeRemoteRequest>("exterior:codemode:execute");
export const exchangeEvent = defineInvokeEventa<CodemodeRemoteReply, CodemodeRemoteMessage[]>("exterior:codemode:exchange");
