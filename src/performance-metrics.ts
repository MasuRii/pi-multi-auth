const DEFAULT_SAMPLE_LIMIT = 512;

export interface MetricSeriesSnapshot {
	count: number;
	min: number;
	max: number;
	average: number;
	p50: number;
	p95: number;
	p99: number;
}

/**
 * Tracks bounded recent samples while preserving aggregate counts for observability snapshots.
 */
export class RollingMetricSeries {
	private readonly samples: number[] = [];
	private count = 0;
	private total = 0;
	private min = Number.POSITIVE_INFINITY;
	private max = 0;

	constructor(private readonly sampleLimit: number = DEFAULT_SAMPLE_LIMIT) {}

	record(value: number): void {
		if (!Number.isFinite(value) || value < 0) {
			return;
		}

		const normalized = Math.round(value * 1000) / 1000;
		this.count += 1;
		this.total += normalized;
		this.min = Math.min(this.min, normalized);
		this.max = Math.max(this.max, normalized);
		if (this.samples.length >= this.sampleLimit) {
			this.samples.shift();
		}
		this.samples.push(normalized);
	}

	snapshot(): MetricSeriesSnapshot {
		if (this.count === 0 || this.samples.length === 0) {
			return {
				count: 0,
				min: 0,
				max: 0,
				average: 0,
				p50: 0,
				p95: 0,
				p99: 0,
			};
		}

		const sorted = [...this.samples].sort((left, right) => left - right);
		return {
			count: this.count,
			min: this.min,
			max: this.max,
			average: Math.round((this.total / this.count) * 1000) / 1000,
			p50: selectPercentile(sorted, 0.5),
			p95: selectPercentile(sorted, 0.95),
			p99: selectPercentile(sorted, 0.99),
		};
	}
}

function selectPercentile(sortedValues: readonly number[], percentile: number): number {
	if (sortedValues.length === 0) {
		return 0;
	}

	const boundedPercentile = Math.min(1, Math.max(0, percentile));
	const index = Math.min(
		sortedValues.length - 1,
		Math.max(0, Math.ceil(sortedValues.length * boundedPercentile) - 1),
	);
	return sortedValues[index] ?? 0;
}
