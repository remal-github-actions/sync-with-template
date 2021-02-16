module.exports = {
    clearMocks: true,
    moduleFileExtensions: ['js', 'ts'],
    testEnvironment: 'node',
    testRunner: 'jest-circus/runner',
    transform: {
        '^.+\\.ts$': 'ts-jest'
    },
    testMatch: [
        '**/*.spec.js',
        '**/*.spec.ts',
    ],
    testPathIgnorePatterns: [
        '/node_modules/',
        '/build/',
        '/dist/',
    ],
    collectCoverage: true,
    collectCoverageFrom: [
        'src/**',
    ],
    verbose: true
}
