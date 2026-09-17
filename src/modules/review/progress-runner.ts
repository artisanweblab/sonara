export type ProgressRunner = <T>(title: string, task: () => Promise<T>) => Promise<T>;

export const silentProgress: ProgressRunner = <T>(_title: string, task: () => Promise<T>): Promise<T> => task();
