module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.cjs'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.cjs'],
  testTimeout: 60000,
  verbose: true,
};
