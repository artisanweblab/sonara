export class TreeExpansion<T> {
    private readonly expanded = new Map<string, boolean>();
    private readonly revisions = new Map<string, number>();

    constructor(
        private readonly keyOf: (node: T) => string | null,
        private readonly childrenOf: (node: T) => readonly T[],
    ) {}

    isExpanded(key: string, isExpandedByDefault: boolean): boolean {
        return this.expanded.get(key) ?? isExpandedByDefault;
    }

    itemId(key: string): string {
        return `${key}#${this.revisions.get(key) ?? 0}`;
    }

    remember(node: T, isExpanded: boolean): void {
        const key = this.keyOf(node);
        if (key) {
            this.expanded.set(key, isExpanded);
        }
    }

    setSubtree(node: T, isExpanded: boolean): void {
        const apply = (target: T, isTargetExpanded: boolean): void => {
            const key = this.keyOf(target);
            if (!key) {
                return;
            }
            this.expanded.set(key, isTargetExpanded);
            this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
            this.childrenOf(target).forEach(child => apply(child, isExpanded));
        };
        apply(node, true);
    }
}
