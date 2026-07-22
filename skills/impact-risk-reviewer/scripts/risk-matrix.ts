export const IMPACT_TOKENS = [
  "Negligible",
  "Minor",
  "Moderate",
  "Significant",
  "Severe",
] as const;

export const LIKELIHOOD_TOKENS = [
  "Rare",
  "Unlikely",
  "Possible",
  "Likely",
  "AlmostCertain",
] as const;

export type ImpactToken = (typeof IMPACT_TOKENS)[number];
export type LikelihoodToken = (typeof LIKELIHOOD_TOKENS)[number];
export type RiskBand = "Low" | "Moderate" | "High" | "VeryHigh" | "Critical";

type AxisRating<Token extends string> = {
  level: number;
  token: Token;
};

export type RiskRating = {
  matrixVersion: "5x5-v1";
  impact: AxisRating<ImpactToken>;
  likelihood: AxisRating<LikelihoodToken>;
  score: number;
  band: RiskBand;
};

const parseAxis = <Token extends string>(
  value: string | number,
  tokens: readonly Token[],
  axis: string,
): AxisRating<Token> => {
  const input = String(value).trim();
  const numericLevel = /^\d$/.test(input) ? Number(input) : undefined;

  if (numericLevel !== undefined && numericLevel >= 1 && numericLevel <= 5) {
    return { level: numericLevel, token: tokens[numericLevel - 1]! };
  }

  const normalized = input.toLowerCase();
  const tokenIndex = tokens.findIndex(
    (token) => token.toLowerCase() === normalized,
  );

  if (tokenIndex >= 0) {
    return { level: tokenIndex + 1, token: tokens[tokenIndex]! };
  }

  throw new Error(`Invalid ${axis}: ${JSON.stringify(value)}`);
};

export const parseImpact = (value: string | number) =>
  parseAxis(value, IMPACT_TOKENS, "impact");

export const parseLikelihood = (value: string | number) => {
  const normalized = String(value).trim().replace(/[ _-]/g, "");
  return parseAxis(normalized, LIKELIHOOD_TOKENS, "likelihood");
};

const bandForScore = (score: number): RiskBand => {
  if (score <= 4) return "Low";
  if (score <= 9) return "Moderate";
  if (score <= 14) return "High";
  if (score <= 19) return "VeryHigh";
  return "Critical";
};

export const calculateRisk = (
  impactInput: string | number,
  likelihoodInput: string | number,
): RiskRating => {
  const impact = parseImpact(impactInput);
  const likelihood = parseLikelihood(likelihoodInput);
  const score = impact.level * likelihood.level;

  return {
    matrixVersion: "5x5-v1",
    impact,
    likelihood,
    score,
    band: bandForScore(score),
  };
};

const readOption = (args: string[], name: string): string => {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) {
    throw new Error(`Missing ${name}`);
  }
  if (args.indexOf(name, index + 1) >= 0) {
    throw new Error(`Duplicate ${name}`);
  }
  return args[index + 1]!;
};

const main = (args: string[]) => {
  if (args[0] !== "score") {
    throw new Error(
      "Usage: risk-matrix score --impact <1-5|label> --likelihood <1-5|label>",
    );
  }

  const impact = readOption(args, "--impact");
  const likelihood = readOption(args, "--likelihood");
  console.log(JSON.stringify(calculateRisk(impact, likelihood)));
};

if (import.meta.main) {
  try {
    main(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
