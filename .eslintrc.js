module.exports = {
  root: true,
  env: {
    node: true,
    jest: true,
    es2021: true
  },
  extends: ['eslint:recommended', 'plugin:jest/recommended'],
  parserOptions: {
    ecmaVersion: 2022
  },
  rules: {
    'jest/prefer-spy-on': 'warn',
    'no-inner-declarations': 'off',
    'no-prototype-builtins': 'off',
    'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
    'max-lines-per-function': ['warn', { max: 300, skipBlankLines: true, skipComments: true }],
    complexity: ['warn', { max: 15 }]
  },
  ignorePatterns: ['node_modules/', 'coverage/', '__tests__/fixtures/', '*.log']
};
