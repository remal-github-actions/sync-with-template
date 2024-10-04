export default {
    clearMocks: true,
    moduleFileExtensions: ['ts', 'js', 'mjs'],
    testEnvironment: 'node',
    testRunner: 'jest-circus/runner',
    extensionsToTreatAsEsm: ['.ts'],
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1'
    },
    transform: {
        '^.+\\.ts$': ['ts-jest', { 'useESM': true }]
    },
    testMatch: [
        '**/*.spec.(ts|js|mjs)'
    ],
    testPathIgnorePatterns: [
        '/build/',
        '/dist/',
        '/node_modules/'
    ],
    collectCoverage: true,
    collectCoverageFrom: [
        'src/**'
    ],
    errorOnDeprecated: true,
    verbose: true,
    setupFiles: [
        '<rootDir>/jest-setup-env.js'
    ],
    setupFilesAfterEnv: [
        '<rootDir>/jest-setup.js'
    ],
    testTimeout: 5000
}
