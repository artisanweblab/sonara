import { AUTO_CRLF_CONFIG_ARGS, GitReader } from './git-reader';

const CONVERSION_ATTRIBUTES = ['text', 'eol', 'crlf', 'ident', 'filter', 'working-tree-encoding'];
const UNSPECIFIED = 'unspecified';
const DISABLED_AUTO_CRLF = ['', 'false', 'no', 'off', '0'];

export type ConversionDirection = 'checkout' | 'commit';

export class ConversionProbe {
    constructor(private readonly reader: GitReader) {}

    async unconvertedPaths(repoPaths: readonly string[], direction: ConversionDirection): Promise<Set<string>> {
        const unique = Array.from(new Set(repoPaths));
        if (unique.length === 0) {
            return new Set();
        }
        const [autoCrlf] = await this.reader.lines([...AUTO_CRLF_CONFIG_ARGS], [0, 1]);
        const autoCrlfValue = (autoCrlf ?? '').trim().toLowerCase();
        if (!DISABLED_AUTO_CRLF.includes(autoCrlfValue) && !(direction === 'checkout' && autoCrlfValue === 'input')) {
            return new Set();
        }
        const records = await this.reader.nulRecords(
            ['check-attr', '-z', '--stdin', ...CONVERSION_ATTRIBUTES],
            Buffer.from(unique.map(repoPath => `${repoPath}\0`).join(''), 'utf8'),
        );
        const converted = new Set<string>();
        for (let position = 0; position + 2 < records.length; position += 3) {
            if (records[position + 2] !== UNSPECIFIED) {
                converted.add(records[position]);
            }
        }
        return new Set(unique.filter(repoPath => !converted.has(repoPath)));
    }
}
