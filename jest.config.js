module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js', 'index.js', 'encounter-api.js', '!src/platforms/**'],
  coverageDirectory: 'coverage',
  verbose: false
};
