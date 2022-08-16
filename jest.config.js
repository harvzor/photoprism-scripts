/** @type {import('ts-jest/dist/types').InitialOptionsTsJest} */
export default {
    preset: 'ts-jest/presets/default-esm', // or other ESM presets
    globals: {
      'ts-jest': {
        useESM: true,
      },
    },
};