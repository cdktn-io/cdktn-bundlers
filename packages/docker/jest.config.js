// Copyright (c) cdktn-io
// SPDX-License-Identifier: MPL-2.0

module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  collectCoverageFrom: ["src/**/*.ts", "!src/**/__tests__/**", "!src/index.ts"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        isolatedModules: true,
        tsconfig: {
          target: "es2019",
          module: "commonjs",
          outDir: "coverage/.ts-jest",
          esModuleInterop: true,
          strict: true,
        },
      },
    ],
  },
};
