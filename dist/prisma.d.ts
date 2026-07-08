interface AllOperationsArgs {
    model?: string;
    operation: string;
    args: unknown;
    query: (args: unknown) => Promise<unknown>;
}
export declare const godeyePrismaExtension: {
    name: string;
    query: {
        $allOperations({ model, operation, args, query }: AllOperationsArgs): Promise<unknown>;
    };
};
export {};
