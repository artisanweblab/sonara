import { LineRange } from '../types';

interface Interval {
    start: number;
    end: number;
}

function toInterval(range: LineRange): Interval {
    const start = range.lines > 0 ? range.start - 1 : range.start;
    return { start, end: start + range.lines };
}

export function rangesOverlap(a: LineRange, b: LineRange): boolean {
    const first = toInterval(a);
    const second = toInterval(b);
    const firstEmpty = first.start === first.end;
    const secondEmpty = second.start === second.end;
    if (firstEmpty && secondEmpty) {
        return first.start === second.start;
    }
    if (firstEmpty) {
        return second.start <= first.start && first.start <= second.end;
    }
    if (secondEmpty) {
        return first.start <= second.start && second.start <= first.end;
    }
    return first.start < second.end && second.start < first.end;
}
