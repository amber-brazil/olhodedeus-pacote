import { type GodeyeOptions } from "./config.js";
export declare function registerGodeyeWorker(options: GodeyeOptions): Promise<{
    forceFlush: () => Promise<void>;
}>;
