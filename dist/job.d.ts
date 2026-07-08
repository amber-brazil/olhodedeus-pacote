export interface MinimalJob {
    name: string;
    queueName: string;
    id?: string | number;
    attemptsMade?: number;
}
export interface GodeyeJobOptions<J> {
    /**
     * Extrai o id do user que originou o job (ex: `j => j.data?.meta?.userId`).
     * Carimba `userId` no evento `job` — como os db_query do worker herdam o mesmo
     * traceId do job, o drawer resolve "quem foi" via traceId. Essencial pros apps
     * webhook-first (mistica/easyfit), onde o trabalho real roda no worker e o
     * setGodeyeUser do web nao alcanca. Nao lanca se o extractor falhar.
     */
    userId?: (job: J) => string | number | null | undefined;
}
export declare function godeyeJobWrapper<J extends MinimalJob, R>(processor: (job: J, token?: string) => Promise<R>, options?: GodeyeJobOptions<J>): (job: J, token?: string) => Promise<R>;
