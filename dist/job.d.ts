export interface MinimalJob {
    name: string;
    queueName: string;
    id?: string | number;
    attemptsMade?: number;
}
export declare function godeyeJobWrapper<J extends MinimalJob, R>(processor: (job: J, token?: string) => Promise<R>): (job: J, token?: string) => Promise<R>;
