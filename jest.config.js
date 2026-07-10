export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      diagnostics: false,
      tsconfig: {
        target: 'ES2020',
        module: 'CommonJS',
        esModuleInterop: true
      }
    }]
  }
};
