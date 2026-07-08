export declare function createRedisErrorReporter(options?: {
    throttleMs?: number;
    now?: () => number;
}): (errorMessage: string) => void;
export declare const reportRedisError: (errorMessage: string) => void;
