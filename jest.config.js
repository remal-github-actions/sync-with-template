module.exports = {
    clearMocks: true,
    moduleFileExtensions: ['ts', 'js', 'mjs'],
    testEnvironment: 'node',
    testRunner: 'jest-circus/runner',
    transform: {
        '^.+\\.ts$': 'ts-jest'
    },
    testMatch: [
        '**/*.spec.(ts|js|mjs)',
    ],
    testPathIgnorePatterns: [
        '/build/',
        '/dist/',
        '/node_modules/',
    ],
    collectCoverage: true,
    collectCoverageFrom: [
        'src/**',
    ],
    errorOnDeprecated: true,
    verbose: true
}
