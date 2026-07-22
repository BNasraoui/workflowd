import { describe, expect, test } from "bun:test";

import { calculateRisk, parseImpact, parseLikelihood } from "./risk-matrix";

const impacts = [
  "Negligible",
  "Minor",
  "Moderate",
  "Significant",
  "Severe",
] as const;

const likelihoods = [
  "Rare",
  "Unlikely",
  "Possible",
  "Likely",
  "AlmostCertain",
] as const;

const expectedBands = [
  ["Low", "Low", "Low", "Low", "Moderate"],
  ["Low", "Low", "Moderate", "Moderate", "High"],
  ["Low", "Moderate", "Moderate", "High", "VeryHigh"],
  ["Low", "Moderate", "High", "VeryHigh", "Critical"],
  ["Moderate", "High", "VeryHigh", "Critical", "Critical"],
] as const;

describe("5x5 risk matrix", () => {
  test("calculates every matrix cell", () => {
    for (const [impactIndex, impact] of impacts.entries()) {
      for (const [likelihoodIndex, likelihood] of likelihoods.entries()) {
        const result = calculateRisk(impact, likelihood);

        expect(result).toEqual({
          matrixVersion: "5x5-v1",
          impact: { level: impactIndex + 1, token: impact },
          likelihood: { level: likelihoodIndex + 1, token: likelihood },
          score: (impactIndex + 1) * (likelihoodIndex + 1),
          band: expectedBands[impactIndex]![likelihoodIndex]!,
        });
      }
    }
  });

  test("rates significant impact with rare likelihood as low risk", () => {
    expect(calculateRisk("Significant", "Rare")).toMatchObject({
      score: 4,
      band: "Low",
    });
  });

  test("keeps all five bands reachable", () => {
    const counts = new Map<string, number>();

    for (const impact of impacts) {
      for (const likelihood of likelihoods) {
        const { band } = calculateRisk(impact, likelihood);
        counts.set(band, (counts.get(band) ?? 0) + 1);
      }
    }

    expect(Object.fromEntries(counts)).toEqual({
      Low: 8,
      Moderate: 7,
      High: 4,
      VeryHigh: 3,
      Critical: 3,
    });
  });

  test("accepts canonical labels, levels, and AlmostCertain separators", () => {
    expect(parseImpact("significant")).toEqual({
      level: 4,
      token: "Significant",
    });
    expect(parseImpact("5")).toEqual({ level: 5, token: "Severe" });
    expect(parseLikelihood("almost certain")).toEqual({
      level: 5,
      token: "AlmostCertain",
    });
    expect(parseLikelihood("almost-certain")).toEqual({
      level: 5,
      token: "AlmostCertain",
    });
    expect(parseLikelihood("almost_certain")).toEqual({
      level: 5,
      token: "AlmostCertain",
    });
  });

  test("rejects missing, out-of-range, fractional, and noncanonical inputs", () => {
    for (const value of [
      "",
      "0",
      "6",
      "2.5",
      "UnknownImpact",
      "priority-high",
    ]) {
      expect(() => parseImpact(value)).toThrow();
    }

    for (const value of [
      "",
      "-1",
      "-5",
      "0",
      "6",
      "2.5",
      "Frequent",
      "priority-high",
    ]) {
      expect(() => parseLikelihood(value)).toThrow();
    }
  });

  test("does not produce a review verdict", () => {
    const output = JSON.stringify(calculateRisk("Severe", "AlmostCertain"));

    expect(output).not.toContain("ImpactReady");
    expect(output).not.toContain("ReviseDesign");
    expect(output).not.toContain("NeedsRiskDecision");
  });
});

describe("risk matrix command", () => {
  const script = `${import.meta.dir}/risk-matrix.ts`;

  test("prints stable JSON for a valid rating", async () => {
    const process = Bun.spawn(
      [
        "bun",
        script,
        "score",
        "--impact",
        "Significant",
        "--likelihood",
        "Rare",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      matrixVersion: "5x5-v1",
      impact: { level: 4, token: "Significant" },
      likelihood: { level: 1, token: "Rare" },
      score: 4,
      band: "Low",
    });
  });

  test("fails without writing stdout for invalid input", async () => {
    const process = Bun.spawn(
      [
        "bun",
        script,
        "score",
        "--impact",
        "Significant",
        "--likelihood",
        "-1",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Invalid likelihood");
  });
});
