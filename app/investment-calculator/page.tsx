"use client";

import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  type ReactNode,
} from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea,
  Legend,
  type TooltipProps,
} from "recharts";
import { Trash2, Plus } from "lucide-react";
import GlassDropdown, {
  type GlassDropdownOption,
} from "@/components/GlassDropdown";
import DashboardLayout from "@/components/DashboardLayout";

// ─── Types ───────────────────────────────────────────────────────────────────

type Frequency = "Daily" | "Weekly" | "Monthly" | "Quarterly" | "Yearly";

interface LifeStage {
  id: string;
  label: string;
  startAge: number;
  endAge: number;
  amount: number;
  frequency: Frequency;
}

interface GlobalInputs {
  currentAge: number;
  retirementAge: number;
  startingPortfolio: number;
  annualReturn: number;
  inflationRate: number;
}

interface DataPoint {
  age: number;
  nominal: number;
  real: number;
  contributed: number;
  stageName: string;
}

interface ProjectionResult {
  dataPoints: DataPoint[];
  finalNominal: number;
  finalReal: number;
  totalContributed: number;
  growthEarned: number;
  multiplier: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const FREQ_MULTIPLIER: Record<Frequency, number> = {
  Daily: 365,
  Weekly: 52,
  Monthly: 12,
  Quarterly: 4,
  Yearly: 1,
};

const FREQUENCY_OPTIONS: GlassDropdownOption[] = [
  { value: "Daily", label: "Daily" },
  { value: "Weekly", label: "Weekly" },
  { value: "Monthly", label: "Monthly" },
  { value: "Quarterly", label: "Quarterly" },
  { value: "Yearly", label: "Yearly" },
];

const LS_KEY = "stash_investment_calculator_v1";

const DEFAULT_GLOBALS: GlobalInputs = {
  currentAge: 22,
  retirementAge: 65,
  startingPortfolio: 0,
  annualReturn: 0.105,
  inflationRate: 0.03,
};

const STAGE_COLORS = ["#60a5fa", "#50C878", "#a78bfa", "#f59e0b", "#f87171", "#34d399"];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildDefaultStages(currentAge: number, retirementAge: number): LifeStage[] {
  return [
    { id: "s1", label: "Student",      startAge: currentAge, endAge: 22,            amount: 50,   frequency: "Monthly" },
    { id: "s2", label: "Early career", startAge: 22,         endAge: 30,            amount: 200,  frequency: "Monthly" },
    { id: "s3", label: "Peak earning", startAge: 30,         endAge: retirementAge, amount: 1000, frequency: "Monthly" },
  ];
}

function fmtCompact(n: number): string {
  if (!isFinite(n)) return "$—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000)     return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)         return `${sign}$${(abs / 1_000).toFixed(0)}k`;
  return `${sign}$${Math.round(abs).toLocaleString()}`;
}

function fmtY(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}k`;
  return `$${v}`;
}

function parseCommas(s: string): number {
  return Number(s.replace(/,/g, "").replace(/[^0-9.-]/g, ""));
}

// ─── Core Calculation ─────────────────────────────────────────────────────────

function calculateProjection(
  globals: GlobalInputs,
  stages: LifeStage[]
): ProjectionResult {
  const { currentAge, retirementAge, startingPortfolio, annualReturn, inflationRate } = globals;

  if (retirementAge <= currentAge || stages.length === 0) {
    return {
      dataPoints: [{ age: currentAge, nominal: startingPortfolio, real: startingPortfolio, contributed: 0, stageName: "" }],
      finalNominal: startingPortfolio,
      finalReal: startingPortfolio,
      totalContributed: 0,
      growthEarned: 0,
      multiplier: 1,
    };
  }

  const monthlyRate = annualReturn / 12;
  let portfolio = startingPortfolio;
  let cumulativeContributions = 0;
  const dataPoints: DataPoint[] = [];

  dataPoints.push({
    age: currentAge,
    nominal: portfolio,
    real: portfolio,
    contributed: 0,
    stageName: stages[0]?.label ?? "",
  });

  for (let year = currentAge; year < retirementAge; year++) {
    const stage =
      stages.find((s) => year >= s.startAge && year < s.endAge) ??
      stages[stages.length - 1];
    const monthlyContrib = (stage.amount * FREQ_MULTIPLIER[stage.frequency]) / 12;

    for (let m = 0; m < 12; m++) {
      portfolio = portfolio * (1 + monthlyRate) + monthlyContrib;
      cumulativeContributions += monthlyContrib;
    }

    const yearsElapsed = year + 1 - currentAge;
    const real = portfolio / Math.pow(1 + inflationRate, yearsElapsed);

    dataPoints.push({
      age: year + 1,
      nominal: portfolio,
      real,
      contributed: cumulativeContributions,
      stageName: stage.label,
    });
  }

  const last = dataPoints[dataPoints.length - 1];
  const growthEarned = last.nominal - last.contributed;
  const multiplier =
    last.contributed > 0
      ? last.nominal / last.contributed
      : startingPortfolio > 0
      ? last.nominal / startingPortfolio
      : 1;

  return {
    dataPoints,
    finalNominal: last.nominal,
    finalReal: last.real,
    totalContributed: last.contributed,
    growthEarned,
    multiplier,
  };
}

// ─── SliderWithInput ──────────────────────────────────────────────────────────

interface SliderWithInputProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  decimals: number;
  markerAt?: number;
  markerLabel?: string;
}

function SliderWithInput({
  label,
  value,
  onChange,
  min,
  max,
  step,
  decimals,
  markerAt,
  markerLabel,
}: SliderWithInputProps) {
  const [textVal, setTextVal] = useState((value * 100).toFixed(decimals));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setTextVal((value * 100).toFixed(decimals));
  }, [value, decimals, focused]);

  const pct = markerAt !== undefined ? ((markerAt - min) / (max - min)) * 100 : null;

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = parseFloat(e.target.value);
    onChange(raw);
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTextVal(e.target.value);
  };

  const handleTextBlur = () => {
    setFocused(false);
    const parsed = parseFloat(textVal);
    if (!isNaN(parsed)) {
      const clamped = Math.min(Math.max(parsed / 100, min), max);
      onChange(clamped);
      setTextVal((clamped * 100).toFixed(decimals));
    } else {
      setTextVal((value * 100).toFixed(decimals));
    }
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-300 mb-2">{label}</label>
      <div className="flex items-center gap-3">
        <div className="relative flex-1 pt-6">
          {pct !== null && (
            <div
              className="absolute top-0 flex flex-col items-center pointer-events-none"
              style={{ left: `calc(${pct}% - 1px)` }}
            >
              <span className="text-[10px] text-gray-400 whitespace-nowrap leading-none mb-0.5">
                {markerLabel}
              </span>
              <div className="w-px h-2 bg-gray-500" />
            </div>
          )}
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={handleSliderChange}
            className="w-full"
          />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <input
            type="text"
            inputMode="decimal"
            value={textVal}
            onChange={handleTextChange}
            onFocus={() => setFocused(true)}
            onBlur={handleTextBlur}
            className="w-16 px-2 py-1.5 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 text-sm text-right focus:border-accent focus:ring-1 focus:ring-accent outline-none"
          />
          <span className="text-gray-400 text-sm">%</span>
        </div>
      </div>
    </div>
  );
}

// ─── MetricCard ───────────────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl bg-[#252525] border border-charcoal-dark p-4">
      <p className="text-sm text-gray-400">{label}</p>
      <p className={`text-2xl font-semibold mt-1 tabular-nums ${accent ? "text-accent" : "text-white"}`}>
        {value}
      </p>
      <p className="text-xs text-gray-500 mt-1">{sub}</p>
    </div>
  );
}

// ─── GlobalInputsSection ──────────────────────────────────────────────────────

interface GlobalInputsSectionProps {
  globals: GlobalInputs;
  globalErrors: Partial<Record<keyof GlobalInputs, string>>;
  onChange: <K extends keyof GlobalInputs>(key: K, value: GlobalInputs[K]) => void;
}

function GlobalInputsSection({ globals, globalErrors, onChange }: GlobalInputsSectionProps) {
  const [portfolioDisplay, setPortfolioDisplay] = useState(
    globals.startingPortfolio === 0 ? "" : globals.startingPortfolio.toLocaleString("en-US")
  );
  const [portfolioFocused, setPortfolioFocused] = useState(false);

  useEffect(() => {
    if (!portfolioFocused) {
      setPortfolioDisplay(
        globals.startingPortfolio === 0 ? "" : globals.startingPortfolio.toLocaleString("en-US")
      );
    }
  }, [globals.startingPortfolio, portfolioFocused]);

  return (
    <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-visible">
      <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark rounded-t-xl">
        <h2 className="text-white font-semibold">Global Parameters</h2>
      </div>
      <div className="p-4 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Current Age */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Current Age</label>
            <input
              type="number"
              min={16}
              max={80}
              value={globals.currentAge}
              onChange={(e) => onChange("currentAge", parseInt(e.target.value) || 0)}
              className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 focus:border-accent focus:ring-1 focus:ring-accent outline-none text-sm"
            />
            {globalErrors.currentAge && (
              <p className="text-xs text-red-400 mt-1">{globalErrors.currentAge}</p>
            )}
          </div>

          {/* Retirement Age */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Retirement Age</label>
            <input
              type="number"
              min={globals.currentAge + 1}
              max={100}
              value={globals.retirementAge}
              onChange={(e) => onChange("retirementAge", parseInt(e.target.value) || 0)}
              className="w-full px-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 focus:border-accent focus:ring-1 focus:ring-accent outline-none text-sm"
            />
            {globalErrors.retirementAge && (
              <p className="text-xs text-red-400 mt-1">{globalErrors.retirementAge}</p>
            )}
          </div>

          {/* Starting Portfolio */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Starting Portfolio</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
              <input
                type="text"
                inputMode="numeric"
                placeholder="0"
                value={portfolioDisplay}
                onChange={(e) => {
                  setPortfolioDisplay(e.target.value);
                  const num = parseCommas(e.target.value);
                  if (isFinite(num) && num >= 0) onChange("startingPortfolio", num);
                }}
                onFocus={() => {
                  setPortfolioFocused(true);
                  setPortfolioDisplay(globals.startingPortfolio === 0 ? "" : String(globals.startingPortfolio));
                }}
                onBlur={() => {
                  setPortfolioFocused(false);
                  const num = parseCommas(portfolioDisplay);
                  const val = isFinite(num) && num >= 0 ? num : 0;
                  onChange("startingPortfolio", val);
                  setPortfolioDisplay(val === 0 ? "" : val.toLocaleString("en-US"));
                }}
                className="w-full pl-7 pr-3 py-2 rounded-lg bg-charcoal border border-charcoal-dark text-gray-200 focus:border-accent focus:ring-1 focus:ring-accent outline-none text-sm"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <SliderWithInput
            label="Expected Annual Return"
            value={globals.annualReturn}
            onChange={(v) => onChange("annualReturn", v)}
            min={0}
            max={0.2}
            step={0.001}
            decimals={1}
            markerAt={0.105}
            markerLabel="S&P avg"
          />
          <SliderWithInput
            label="Inflation Rate"
            value={globals.inflationRate}
            onChange={(v) => onChange("inflationRate", v)}
            min={0}
            max={0.1}
            step={0.001}
            decimals={1}
          />
        </div>
      </div>
    </div>
  );
}

// ─── LifeStageTable ───────────────────────────────────────────────────────────

interface LifeStageTableProps {
  stages: LifeStage[];
  stageErrors: Record<string, string>;
  retirementAge: number;
  onAdd: () => void;
  onDelete: (id: string) => void;
  onUpdateField: <K extends keyof LifeStage>(id: string, key: K, value: LifeStage[K]) => void;
  onUpdateEndAge: (id: string, newEnd: number) => void;
}

function LifeStageTable({
  stages,
  stageErrors,
  retirementAge,
  onAdd,
  onDelete,
  onUpdateField,
  onUpdateEndAge,
}: LifeStageTableProps) {
  // Per-row display state for amount inputs
  const [amountDisplays, setAmountDisplays] = useState<Record<string, string>>({});
  const [amountFocused, setAmountFocused] = useState<Record<string, boolean>>({});

  const getAmountDisplay = (stage: LifeStage) => {
    if (amountFocused[stage.id]) return amountDisplays[stage.id] ?? String(stage.amount);
    return stage.amount === 0 ? "" : stage.amount.toLocaleString("en-US");
  };

  return (
    <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-visible">
      <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark rounded-t-xl flex items-center justify-between">
        <h2 className="text-white font-semibold">Life Stages</h2>
        <p className="text-xs text-gray-400">Define your contribution timeline</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr className="border-b border-charcoal-dark">
              <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-gray-400">Stage</th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-gray-400">Start Age</th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-gray-400">End Age</th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-gray-400">Amount</th>
              <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-gray-400">Frequency</th>
              <th className="px-4 py-2.5 w-10" />
            </tr>
          </thead>
          <tbody>
            {stages.map((stage, idx) => {
              const hasError = !!stageErrors[stage.id];
              return (
                <>
                  <tr
                    key={stage.id}
                    className={`border-b border-charcoal-dark/60 transition-colors hover:bg-[#2C2C2C] ${hasError ? "bg-red-500/5" : idx % 2 === 0 ? "bg-[#252525]" : "bg-[#2C2C2C]"}`}
                  >
                    {/* Stage label */}
                    <td className="px-4 py-2.5">
                      <input
                        type="text"
                        value={stage.label}
                        onChange={(e) => onUpdateField(stage.id, "label", e.target.value)}
                        className="w-full min-w-[110px] px-2 py-1.5 rounded-md bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                      />
                    </td>

                    {/* Start age (read-only except row 0 indirectly via currentAge) */}
                    <td className="px-4 py-2.5">
                      <div className="px-2 py-1.5 rounded-md bg-charcoal/50 border border-charcoal-dark/50 text-gray-500 text-sm w-16 text-center select-none">
                        {stage.startAge}
                      </div>
                    </td>

                    {/* End age */}
                    <td className="px-4 py-2.5">
                      <input
                        type="number"
                        min={stage.startAge + 1}
                        max={retirementAge}
                        value={stage.endAge}
                        onChange={(e) => {
                          const v = parseInt(e.target.value);
                          if (!isNaN(v)) onUpdateEndAge(stage.id, v);
                        }}
                        className={`w-16 px-2 py-1.5 rounded-md bg-charcoal border text-gray-200 text-sm focus:ring-1 outline-none text-center ${hasError ? "border-red-500 focus:border-red-400 focus:ring-red-500/30" : "border-charcoal-dark focus:border-accent focus:ring-accent"}`}
                      />
                    </td>

                    {/* Amount */}
                    <td className="px-4 py-2.5">
                      <div className="relative">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          placeholder="0"
                          value={getAmountDisplay(stage)}
                          onChange={(e) => {
                            setAmountDisplays((p) => ({ ...p, [stage.id]: e.target.value }));
                            const num = parseCommas(e.target.value);
                            if (isFinite(num) && num >= 0) onUpdateField(stage.id, "amount", num);
                          }}
                          onFocus={() => {
                            setAmountFocused((p) => ({ ...p, [stage.id]: true }));
                            setAmountDisplays((p) => ({ ...p, [stage.id]: String(stage.amount) }));
                          }}
                          onBlur={() => {
                            setAmountFocused((p) => ({ ...p, [stage.id]: false }));
                            const num = parseCommas(amountDisplays[stage.id] ?? String(stage.amount));
                            const val = isFinite(num) && num >= 0 ? num : 0;
                            onUpdateField(stage.id, "amount", val);
                          }}
                          className="w-28 pl-6 pr-2 py-1.5 rounded-md bg-charcoal border border-charcoal-dark text-gray-200 text-sm focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                        />
                      </div>
                    </td>

                    {/* Frequency */}
                    <td className="px-4 py-2.5">
                      <GlassDropdown
                        value={stage.frequency}
                        onChange={(v) => onUpdateField(stage.id, "frequency", v as Frequency)}
                        options={FREQUENCY_OPTIONS}
                        className="text-sm"
                        panelClassName="min-w-[130px]"
                      />
                    </td>

                    {/* Delete */}
                    <td className="px-3 py-2.5">
                      <button
                        onClick={() => onDelete(stage.id)}
                        disabled={stages.length <= 1}
                        className="p-1.5 rounded-md text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-25 disabled:cursor-not-allowed disabled:hover:text-gray-500 disabled:hover:bg-transparent"
                        aria-label="Delete stage"
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>

                  {/* Inline error row */}
                  {hasError && (
                    <tr key={`${stage.id}-err`} className={idx % 2 === 0 ? "bg-[#252525]" : "bg-[#2C2C2C]"}>
                      <td colSpan={6} className="px-4 pb-2 pt-0">
                        <p className="text-xs text-red-400">{stageErrors[stage.id]}</p>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="px-4 py-3 border-t border-charcoal-dark/60">
        <button
          onClick={onAdd}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-charcoal border border-charcoal-dark text-gray-300 text-sm hover:text-white hover:border-accent/50 transition-colors"
        >
          <Plus size={14} />
          Add life stage
        </button>
      </div>
    </div>
  );
}

// ─── CustomTooltip ────────────────────────────────────────────────────────────

function CustomTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload as DataPoint;
  return (
    <div
      style={{
        backgroundColor: "#2F2F2F",
        border: "1px solid #474747",
        borderRadius: "8px",
        color: "#e5e7eb",
        padding: "10px 14px",
        fontSize: "12px",
      }}
    >
      <p className="font-semibold text-white mb-0.5">Age {d.age}</p>
      {d.stageName && <p className="text-gray-400 text-[11px] mb-2">{d.stageName}</p>}
      {payload.map((entry) => (
        <p key={entry.name} style={{ color: entry.color ?? "#fff" }} className="leading-5">
          {entry.name}: {fmtCompact(entry.value as number)}
        </p>
      ))}
    </div>
  );
}

// ─── ProjectionChart ──────────────────────────────────────────────────────────

interface ProjectionChartProps {
  result: ProjectionResult | null;
  stages: LifeStage[];
  xAxisTicks: number[];
}

function ProjectionChart({ result, stages, xAxisTicks }: ProjectionChartProps) {
  if (!result || result.dataPoints.length < 2) {
    return (
      <div className="h-[360px] flex items-center justify-center text-gray-500 text-sm">
        Fix validation errors above to see your projection
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={360}>
      <LineChart data={result.dataPoints} margin={{ top: 28, right: 16, bottom: 8, left: 12 }}>
        {stages.map((s, i) => (
          <ReferenceArea
            key={s.id}
            x1={s.startAge}
            x2={s.endAge}
            fill={STAGE_COLORS[i % STAGE_COLORS.length]}
            fillOpacity={0.07}
            label={{
              value: s.label,
              position: "insideTopLeft",
              fill: "#9ca3af",
              fontSize: 10,
              dy: -14,
            }}
          />
        ))}

        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />

        <XAxis
          dataKey="age"
          stroke="#9ca3af"
          tick={{ fill: "#9ca3af", fontSize: 11 }}
          ticks={xAxisTicks}
          label={{ value: "Age", position: "insideBottomRight", fill: "#6b7280", fontSize: 11, dy: 6 }}
        />

        <YAxis
          stroke="#9ca3af"
          tick={{ fill: "#9ca3af", fontSize: 11 }}
          tickFormatter={fmtY}
          width={62}
        />

        <Tooltip content={<CustomTooltip />} />

        <Legend
          wrapperStyle={{ fontSize: "12px", color: "#9ca3af", paddingTop: "8px" }}
        />

        <Line
          type="monotone"
          dataKey="nominal"
          name="Nominal"
          stroke="#60a5fa"
          strokeWidth={2.5}
          dot={false}
          isAnimationActive
          animationDuration={400}
        />
        <Line
          type="monotone"
          dataKey="real"
          name="Real (Today's $)"
          stroke="#50C878"
          strokeWidth={2.5}
          dot={false}
          isAnimationActive
          animationDuration={400}
        />
        <Line
          type="monotone"
          dataKey="contributed"
          name="Total Contributed"
          stroke="#9ca3af"
          strokeWidth={1.5}
          dot={false}
          strokeDasharray="5 3"
          isAnimationActive
          animationDuration={400}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ─── MetricsCards ─────────────────────────────────────────────────────────────

function MetricsCards({ result }: { result: ProjectionResult | null }) {
  const r = result;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <MetricCard
        label="Final Portfolio"
        value={r ? fmtCompact(r.finalNominal) : "—"}
        sub="nominal value"
        accent
      />
      <MetricCard
        label="In Today's Dollars"
        value={r ? fmtCompact(r.finalReal) : "—"}
        sub="inflation-adjusted"
      />
      <MetricCard
        label="Total Contributed"
        value={r ? fmtCompact(r.totalContributed) : "—"}
        sub="your deposits"
      />
      <MetricCard
        label="Growth Earned"
        value={r ? fmtCompact(r.growthEarned) : "—"}
        sub={r ? `${r.multiplier.toFixed(1)}× your money` : "—"}
      />
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function InvestmentCalculatorPage() {
  const [globals, setGlobals] = useState<GlobalInputs>(DEFAULT_GLOBALS);
  const [stages, setStages] = useState<LifeStage[]>(() =>
    buildDefaultStages(DEFAULT_GLOBALS.currentAge, DEFAULT_GLOBALS.retirementAge)
  );

  // ── Load from localStorage on mount ──────────────────────────────────────
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed?.globals && typeof parsed.globals.currentAge === "number") {
        setGlobals(parsed.globals);
      }
      if (Array.isArray(parsed?.stages) && parsed.stages.length > 0) {
        setStages(parsed.stages);
      }
    } catch {
      // ignore malformed data
    }
  }, []);

  // ── Save to localStorage (debounced 300ms) ────────────────────────────────
  const saveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveRef.current) clearTimeout(saveRef.current);
    saveRef.current = setTimeout(() => {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({ globals, stages }));
      } catch {
        // private browsing / quota
      }
    }, 300);
    return () => {
      if (saveRef.current) clearTimeout(saveRef.current);
    };
  }, [globals, stages]);

  // ── Sync row 1 startAge when currentAge changes ───────────────────────────
  useEffect(() => {
    setStages((prev) =>
      prev.map((s, i) => (i === 0 ? { ...s, startAge: globals.currentAge } : s))
    );
  }, [globals.currentAge]);

  // ── Debounced calculation inputs (150ms) ──────────────────────────────────
  const [debouncedGlobals, setDebouncedGlobals] = useState(globals);
  const [debouncedStages, setDebouncedStages] = useState(stages);
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedGlobals(globals);
      setDebouncedStages(stages);
    }, 150);
    return () => clearTimeout(t);
  }, [globals, stages]);

  // ── Validation ────────────────────────────────────────────────────────────
  const stageErrors = useMemo<Record<string, string>>(() => {
    const errors: Record<string, string> = {};
    stages.forEach((s, i) => {
      if (s.endAge <= s.startAge) {
        errors[s.id] = "End age must be greater than start age";
      } else if (s.endAge > globals.retirementAge) {
        errors[s.id] = `End age cannot exceed retirement age (${globals.retirementAge})`;
      } else if (s.amount < 0) {
        errors[s.id] = "Contribution must be non-negative";
      } else if (i > 0 && stages[i - 1].endAge !== s.startAge) {
        errors[s.id] = `Must start at age ${stages[i - 1].endAge} (contiguous with previous stage)`;
      }
    });
    return errors;
  }, [stages, globals.retirementAge]);

  const globalErrors = useMemo<Partial<Record<keyof GlobalInputs, string>>>(() => {
    const e: Partial<Record<keyof GlobalInputs, string>> = {};
    if (globals.currentAge < 16 || globals.currentAge > 80)
      e.currentAge = "Must be between 16 and 80";
    if (globals.retirementAge <= globals.currentAge)
      e.retirementAge = "Must be greater than current age";
    return e;
  }, [globals]);

  const hasErrors =
    Object.keys(stageErrors).length > 0 || Object.keys(globalErrors).length > 0;

  // ── Calculation ───────────────────────────────────────────────────────────
  const result = useMemo<ProjectionResult | null>(() => {
    if (hasErrors) return null;
    return calculateProjection(debouncedGlobals, debouncedStages);
  }, [debouncedGlobals, debouncedStages, hasErrors]);

  // ── X-axis ticks ──────────────────────────────────────────────────────────
  const xAxisTicks = useMemo<number[]>(() => {
    const range = globals.retirementAge - globals.currentAge;
    const step = range < 15 ? 1 : 5;
    const ticks: number[] = [];
    const start = Math.ceil(globals.currentAge / step) * step;
    for (let age = start; age <= globals.retirementAge; age += step) ticks.push(age);
    if (!ticks.includes(globals.currentAge)) ticks.unshift(globals.currentAge);
    if (!ticks.includes(globals.retirementAge)) ticks.push(globals.retirementAge);
    return ticks;
  }, [globals.currentAge, globals.retirementAge]);

  // ── Callbacks ─────────────────────────────────────────────────────────────
  const updateGlobal = useCallback(
    <K extends keyof GlobalInputs>(key: K, value: GlobalInputs[K]) => {
      setGlobals((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const addStage = useCallback(() => {
    setStages((prev) => {
      const last = prev[prev.length - 1];
      if (last.endAge >= globals.retirementAge) return prev;
      const newStage: LifeStage = {
        id: String(Date.now()),
        label: "New stage",
        startAge: last.endAge,
        endAge: Math.min(last.endAge + 10, globals.retirementAge),
        amount: 500,
        frequency: "Monthly",
      };
      return [...prev, newStage];
    });
  }, [globals.retirementAge]);

  const deleteStage = useCallback((id: string) => {
    setStages((prev) => (prev.length <= 1 ? prev : prev.filter((s) => s.id !== id)));
  }, []);

  const updateField = useCallback(
    <K extends keyof LifeStage>(id: string, key: K, value: LifeStage[K]) => {
      setStages((prev) => prev.map((s) => (s.id === id ? { ...s, [key]: value } : s)));
    },
    []
  );

  const updateEndAge = useCallback((id: string, newEnd: number) => {
    setStages((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      if (idx < 0) return prev;
      return prev.map((s, i) => {
        if (i === idx) return { ...s, endAge: newEnd };
        if (i === idx + 1) return { ...s, startAge: newEnd };
        return s;
      });
    });
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-6xl mx-auto">
        <div>
          <h1 className="text-2xl font-semibold text-white">Life-Stage Investment Calculator</h1>
          <p className="text-sm text-gray-400 mt-1">
            Model your financial journey across different life stages to see how your wealth grows over time.
          </p>
        </div>

        <GlobalInputsSection
          globals={globals}
          globalErrors={globalErrors}
          onChange={updateGlobal}
        />

        <LifeStageTable
          stages={stages}
          stageErrors={stageErrors}
          retirementAge={globals.retirementAge}
          onAdd={addStage}
          onDelete={deleteStage}
          onUpdateField={updateField}
          onUpdateEndAge={updateEndAge}
        />

        <MetricsCards result={result} />

        <div className="rounded-xl bg-[#252525] border border-charcoal-dark overflow-visible">
          <div className="px-4 py-3 bg-[#353535] border-b border-charcoal-dark rounded-t-xl flex items-center justify-between">
            <h2 className="text-white font-semibold">Portfolio Projection</h2>
            <div className="flex items-center gap-4 text-xs text-gray-400">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 bg-[#60a5fa] rounded inline-block" />
                Nominal
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 bg-accent rounded inline-block" />
                Real (Today&apos;s $)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 bg-gray-400 rounded inline-block" style={{ backgroundImage: "repeating-linear-gradient(to right, #9ca3af 0, #9ca3af 4px, transparent 4px, transparent 7px)" }} />
                Contributed
              </span>
            </div>
          </div>
          <div className="p-4">
            <ProjectionChart
              result={result}
              stages={stages}
              xAxisTicks={xAxisTicks}
            />
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
