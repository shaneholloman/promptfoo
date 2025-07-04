import fs from 'fs';
import path from 'path';
import { loadFromJavaScriptFile } from '../src/assertions/utils';
import cliState from '../src/cliState';
import { importModule } from '../src/esm';
import {
  getAndCheckProvider,
  getGradingProvider,
  matchesClassification,
  matchesModeration,
  matchesSimilarity,
  matchesLlmRubric,
  matchesFactuality,
  matchesClosedQa,
  matchesAnswerRelevance,
  matchesContextRelevance,
  matchesContextRecall,
  matchesContextFaithfulness,
  renderLlmRubricPrompt,
  matchesGEval,
} from '../src/matchers';
import { ANSWER_RELEVANCY_GENERATE } from '../src/prompts';
import { HuggingfaceTextClassificationProvider } from '../src/providers/huggingface';
import { OpenAiChatCompletionProvider } from '../src/providers/openai/chat';
import { DefaultEmbeddingProvider, DefaultGradingProvider } from '../src/providers/openai/defaults';
import { OpenAiEmbeddingProvider } from '../src/providers/openai/embedding';
import { OpenAiModerationProvider } from '../src/providers/openai/moderation';
import { ReplicateModerationProvider } from '../src/providers/replicate';
import { LLAMA_GUARD_REPLICATE_PROVIDER } from '../src/redteam/constants';
import * as remoteGrading from '../src/remoteGrading';
import type {
  ApiProvider,
  Assertion,
  GradingConfig,
  ProviderClassificationResponse,
  ProviderResponse,
  ProviderTypeMap,
} from '../src/types';
import { TestGrader } from './util/utils';

jest.mock('../src/database', () => ({
  getDb: jest.fn().mockImplementation(() => {
    throw new TypeError('The "original" argument must be of type function. Received undefined');
  }),
}));
jest.mock('../src/esm');
jest.mock('../src/cliState');
jest.mock('../src/remoteGrading', () => ({
  doRemoteGrading: jest.fn(),
}));
jest.mock('../src/redteam/remoteGeneration', () => ({
  shouldGenerateRemote: jest.fn().mockReturnValue(true),
}));
jest.mock('proxy-agent', () => ({
  ProxyAgent: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('glob', () => ({
  globSync: jest.fn(),
}));
jest.mock('better-sqlite3');
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn(),
  existsSync: jest.fn(),
}));
jest.mock('../src/esm', () => ({
  importModule: jest.fn(),
}));

const Grader = new TestGrader();

describe('matchesSimilarity', () => {
  beforeEach(() => {
    jest.spyOn(DefaultEmbeddingProvider, 'callEmbeddingApi').mockImplementation((text) => {
      if (text === 'Expected output' || text === 'Sample output') {
        return Promise.resolve({
          embedding: [1, 0, 0],
          tokenUsage: { total: 5, prompt: 2, completion: 3 },
        });
      } else if (text === 'Different output') {
        return Promise.resolve({
          embedding: [0, 1, 0],
          tokenUsage: { total: 5, prompt: 2, completion: 3 },
        });
      }
      return Promise.reject(new Error('Unexpected input'));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should pass when similarity is above the threshold', async () => {
    const expected = 'Expected output';
    const output = 'Sample output';
    const threshold = 0.5;

    await expect(matchesSimilarity(expected, output, threshold)).resolves.toEqual({
      pass: true,
      reason: 'Similarity 1.00 is greater than threshold 0.5',
      score: 1,
      tokensUsed: {
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
        cached: expect.any(Number),
        completionDetails: expect.any(Object),
      },
    });
  });

  it('should fail when similarity is below the threshold', async () => {
    const expected = 'Expected output';
    const output = 'Different output';
    const threshold = 0.9;

    await expect(matchesSimilarity(expected, output, threshold)).resolves.toEqual({
      pass: false,
      reason: 'Similarity 0.00 is less than threshold 0.9',
      score: 0,
      tokensUsed: {
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
        cached: expect.any(Number),
        completionDetails: expect.any(Object),
      },
    });
  });

  it('should fail when inverted similarity is above the threshold', async () => {
    const expected = 'Expected output';
    const output = 'Sample output';
    const threshold = 0.5;

    await expect(
      matchesSimilarity(expected, output, threshold, true /* invert */),
    ).resolves.toEqual({
      pass: false,
      reason: 'Similarity 1.00 is greater than threshold 0.5',
      score: 0,
      tokensUsed: {
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
        cached: expect.any(Number),
        completionDetails: expect.any(Object),
      },
    });
  });

  it('should pass when inverted similarity is below the threshold', async () => {
    const expected = 'Expected output';
    const output = 'Different output';
    const threshold = 0.9;

    await expect(
      matchesSimilarity(expected, output, threshold, true /* invert */),
    ).resolves.toEqual({
      pass: true,
      reason: 'Similarity 0.00 is less than threshold 0.9',
      score: 1,
      tokensUsed: {
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
        cached: expect.any(Number),
        completionDetails: expect.any(Object),
      },
    });
  });

  it('should use the overridden similarity grading config', async () => {
    const expected = 'Expected output';
    const output = 'Sample output';
    const threshold = 0.5;
    const grading: GradingConfig = {
      provider: {
        id: 'openai:embedding:text-embedding-ada-9999999',
        config: {
          apiKey: 'abc123',
          temperature: 3.1415926,
        },
      },
    };

    const mockCallApi = jest.spyOn(OpenAiEmbeddingProvider.prototype, 'callEmbeddingApi');
    mockCallApi.mockImplementation(function (this: OpenAiChatCompletionProvider) {
      expect(this.config.temperature).toBe(3.1415926);
      expect(this.getApiKey()).toBe('abc123');
      return Promise.resolve({
        embedding: [1, 0, 0],
        tokenUsage: { total: 5, prompt: 2, completion: 3 },
      });
    });

    await expect(matchesSimilarity(expected, output, threshold, false, grading)).resolves.toEqual({
      pass: true,
      reason: 'Similarity 1.00 is greater than threshold 0.5',
      score: 1,
      tokensUsed: {
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
        cached: expect.any(Number),
        completionDetails: expect.any(Object),
      },
    });
    expect(mockCallApi).toHaveBeenCalledWith('Expected output');

    mockCallApi.mockRestore();
  });

  it('should throw an error when API call fails', async () => {
    const expected = 'Expected output';
    const output = 'Sample output';
    const threshold = 0.5;
    const grading: GradingConfig = {
      provider: {
        id: 'openai:embedding:text-embedding-ada-9999999',
        config: {
          apiKey: 'abc123',
          temperature: 3.1415926,
        },
      },
    };

    jest
      .spyOn(OpenAiEmbeddingProvider.prototype, 'callEmbeddingApi')
      .mockRejectedValueOnce(new Error('API call failed'));

    await expect(async () => {
      await matchesSimilarity(expected, output, threshold, false, grading);
    }).rejects.toThrow('API call failed');
  });

  it('should use Nunjucks templating when PROMPTFOO_DISABLE_TEMPLATING is set', async () => {
    process.env.PROMPTFOO_DISABLE_TEMPLATING = 'true';
    const expected = 'Expected {{ var }}';
    const output = 'Output {{ var }}';
    const threshold = 0.8;
    const grading: GradingConfig = {
      provider: DefaultEmbeddingProvider,
    };

    jest.spyOn(DefaultEmbeddingProvider, 'callEmbeddingApi').mockResolvedValue({
      embedding: [1, 2, 3],
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });

    await matchesSimilarity(expected, output, threshold, false, grading);

    expect(DefaultEmbeddingProvider.callEmbeddingApi).toHaveBeenCalledWith('Expected {{ var }}');
    expect(DefaultEmbeddingProvider.callEmbeddingApi).toHaveBeenCalledWith('Output {{ var }}');

    process.env.PROMPTFOO_DISABLE_TEMPLATING = undefined;
  });
});

describe('matchesLlmRubric', () => {
  const mockFilePath = path.join('path', 'to', 'external', 'rubric.txt');
  const mockFileContent = 'This is an external rubric prompt';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetAllMocks();
    jest.mocked(fs.existsSync).mockReturnValue(true);
    jest.mocked(fs.readFileSync).mockReturnValue(mockFileContent);

    // Reset cliState to default
    (cliState as any).config = {};

    // Reset remote grading mock with default behavior
    jest.mocked(remoteGrading.doRemoteGrading).mockReset();
    jest.mocked(remoteGrading.doRemoteGrading).mockResolvedValue({
      pass: true,
      score: 1,
      reason: 'Remote grading passed',
    });

    // Reset DefaultGradingProvider mock to prevent contamination
    jest.spyOn(DefaultGradingProvider, 'callApi').mockReset();
    jest.spyOn(DefaultGradingProvider, 'callApi').mockResolvedValue({
      output: JSON.stringify({ pass: true, score: 1, reason: 'Test passed' }),
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });
  });

  it('should pass when the grading provider returns a passing result', async () => {
    const expected = 'Expected output';
    const output = 'Sample output';
    const options: GradingConfig = {
      rubricPrompt: 'Grading prompt',
      provider: Grader,
    };

    // Ensure Grader mock is properly set up for this test
    jest.spyOn(Grader, 'callApi').mockResolvedValue({
      output: JSON.stringify({ pass: true, reason: 'Test grading output' }),
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });

    await expect(matchesLlmRubric(expected, output, options)).resolves.toEqual({
      pass: true,
      reason: 'Test grading output',
      score: 1,
      tokensUsed: {
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
        cached: expect.any(Number),
        completionDetails: expect.any(Object),
      },
    });
  });

  it('should handle when provider returns direct object output instead of string', async () => {
    const expected = 'Expected output';
    const output = 'Sample output';
    const options: GradingConfig = {
      rubricPrompt: 'Grading prompt',
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: { pass: true, score: 0.85, reason: 'Direct object output' },
          tokenUsage: { total: 10, prompt: 5, completion: 5 },
        }),
      },
    };

    await expect(matchesLlmRubric(expected, output, options)).resolves.toEqual({
      pass: true,
      score: 0.85,
      reason: 'Direct object output',
      assertion: undefined,
      tokensUsed: {
        total: 10,
        prompt: 5,
        completion: 5,
        cached: 0,
        completionDetails: {
          reasoning: 0,
          acceptedPrediction: 0,
          rejectedPrediction: 0,
        },
      },
    });
  });

  it('should render rubric when provided as an object', async () => {
    const rubric = { prompt: 'Describe the image' };
    const output = 'Sample output';
    const options: GradingConfig = {
      rubricPrompt: 'Grade: {{ rubric }}',
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: JSON.stringify({ pass: true, score: 1, reason: 'ok' }),
          tokenUsage: { total: 1, prompt: 1, completion: 1 },
        }),
      },
    };

    await matchesLlmRubric(rubric, output, options);

    expect(options.provider.callApi).toHaveBeenCalledWith(
      expect.stringContaining(JSON.stringify(rubric)),
    );
  });

  it('should fail when output is neither string nor object', async () => {
    const expected = 'Expected output';
    const output = 'Sample output';
    const options: GradingConfig = {
      rubricPrompt: 'Grading prompt',
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: 42, // Numeric output
          tokenUsage: { total: 10, prompt: 5, completion: 5 },
        }),
      },
    };

    await expect(matchesLlmRubric(expected, output, options)).resolves.toEqual({
      assertion: undefined,
      pass: false,
      score: 0,
      reason: 'llm-rubric produced malformed response - output must be string or object',
      tokensUsed: {
        total: 10,
        prompt: 5,
        completion: 5,
        cached: 0,
        completionDetails: undefined,
      },
    });
  });

  it('should handle string output with invalid JSON format', async () => {
    const expected = 'Expected output';
    const output = 'Sample output';
    const options: GradingConfig = {
      rubricPrompt: 'Grading prompt',
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: '{ "pass": true, "reason": "Invalid JSON missing closing brace',
          tokenUsage: { total: 10, prompt: 5, completion: 5 },
        }),
      },
    };

    await expect(matchesLlmRubric(expected, output, options)).resolves.toEqual({
      assertion: undefined,
      pass: false,
      score: 0,
      reason: expect.stringContaining('Could not extract JSON from llm-rubric response'),
      tokensUsed: {
        total: 10,
        prompt: 5,
        completion: 5,
        cached: 0,
        completionDetails: undefined,
      },
    });
  });

  it('should fail when string output contains no JSON objects', async () => {
    const expected = 'Expected output';
    const output = 'Sample output';
    const options: GradingConfig = {
      rubricPrompt: 'Grading prompt',
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: 'This is a valid text response but contains no JSON objects',
          tokenUsage: { total: 10, prompt: 5, completion: 5 },
        }),
      },
    };

    await expect(matchesLlmRubric(expected, output, options)).resolves.toEqual({
      assertion: undefined,
      pass: false,
      score: 0,
      reason: 'Could not extract JSON from llm-rubric response',
      tokensUsed: {
        total: 10,
        prompt: 5,
        completion: 5,
        cached: 0,
        completionDetails: undefined,
      },
    });
  });

  it('should fail when the grading provider returns a failing result', async () => {
    const expected = 'Expected output';
    const output = 'Different output';
    const options: GradingConfig = {
      rubricPrompt: 'Grading prompt',
      provider: Grader,
    };

    jest.spyOn(Grader, 'callApi').mockResolvedValueOnce({
      output: JSON.stringify({ pass: false, reason: 'Grading failed' }),
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });

    await expect(matchesLlmRubric(expected, output, options)).resolves.toEqual({
      pass: false,
      reason: 'Grading failed',
      score: 0,
      tokensUsed: {
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
        cached: expect.any(Number),
        completionDetails: expect.any(Object),
      },
    });
  });

  it('should throw error when throwOnError is true and provider returns an error', async () => {
    const rubric = 'Test rubric';
    const llmOutput = 'Test output';
    const grading: GradingConfig = {
      rubricPrompt: 'Grading prompt',
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          error: 'Provider error',
          output: null,
          tokenUsage: { total: 10, prompt: 5, completion: 5 },
        }),
      },
    };

    // With throwOnError: true - should throw
    await expect(
      matchesLlmRubric(rubric, llmOutput, grading, {}, null, { throwOnError: true }),
    ).rejects.toThrow('Provider error');
  });

  it('should throw error when throwOnError is true and provider returns no result', async () => {
    const rubric = 'Test rubric';
    const llmOutput = 'Test output';
    const grading: GradingConfig = {
      rubricPrompt: 'Grading prompt',
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          error: null,
          output: null,
          tokenUsage: { total: 10, prompt: 5, completion: 5 },
        }),
      },
    };

    // With throwOnError: true - should throw
    await expect(
      matchesLlmRubric(rubric, llmOutput, grading, {}, null, { throwOnError: true }),
    ).rejects.toThrow('No output');
  });

  it('should use the overridden llm rubric grading config', async () => {
    const expected = 'Expected output';
    const output = 'Sample output';
    const options: GradingConfig = {
      rubricPrompt: 'Grading prompt',
      provider: {
        id: 'openai:gpt-4o-mini',
        config: {
          apiKey: 'abc123',
          temperature: 3.1415926,
        },
      },
    };

    const mockCallApi = jest.spyOn(OpenAiChatCompletionProvider.prototype, 'callApi');
    mockCallApi.mockImplementation(function (this: OpenAiChatCompletionProvider) {
      expect(this.config.temperature).toBe(3.1415926);
      expect(this.getApiKey()).toBe('abc123');
      return Promise.resolve({
        output: JSON.stringify({ pass: true, reason: 'Grading passed' }),
        tokenUsage: { total: 10, prompt: 5, completion: 5 },
      });
    });

    await expect(matchesLlmRubric(expected, output, options)).resolves.toEqual({
      reason: 'Grading passed',
      pass: true,
      score: 1,
      tokensUsed: {
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
        cached: expect.any(Number),
        completionDetails: expect.any(Object),
      },
    });
    expect(mockCallApi).toHaveBeenCalledWith('Grading prompt');

    mockCallApi.mockRestore();
  });

  it('should use provided score threshold if llm does not return pass', async () => {
    const rubricPrompt = 'Rubric prompt';
    const llmOutput = 'Sample output';
    const assertion: Assertion = {
      type: 'llm-rubric',
      value: rubricPrompt,
      threshold: 0.5,
    };

    const lowScoreResponse = { score: 0.25, reason: 'Low score' };
    const lowScoreProvider: ApiProvider = {
      id: () => 'test-provider',
      callApi: jest.fn().mockResolvedValue({
        output: JSON.stringify(lowScoreResponse),
      }),
    };

    await expect(
      matchesLlmRubric(
        rubricPrompt,
        llmOutput,
        { rubricPrompt, provider: lowScoreProvider },
        {},
        assertion,
      ),
    ).resolves.toEqual(expect.objectContaining({ assertion, pass: false, ...lowScoreResponse }));

    const highScoreResponse = { score: 0.75, reason: 'High score' };
    const highScoreProvider: ApiProvider = {
      id: () => 'test-provider',
      callApi: jest.fn().mockResolvedValue({
        output: JSON.stringify(highScoreResponse),
      }),
    };
    await expect(
      matchesLlmRubric(
        rubricPrompt,
        llmOutput,
        { rubricPrompt, provider: highScoreProvider },
        {},
        assertion,
      ),
    ).resolves.toEqual(expect.objectContaining({ assertion, pass: true, ...highScoreResponse }));
  });

  it('should ignore the score threshold if llm returns pass', async () => {
    const rubricPrompt = 'Rubric prompt';
    const output = 'Sample output';
    const assertion: Assertion = {
      type: 'llm-rubric',
      value: rubricPrompt,
      threshold: 0.1,
    };

    const lowScoreResult = { score: 0.25, reason: 'Low score but pass', pass: true };
    const lowScoreOptions: GradingConfig = {
      rubricPrompt,
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: JSON.stringify(lowScoreResult),
        }),
      },
    };

    await expect(
      matchesLlmRubric(rubricPrompt, output, lowScoreOptions, {}, assertion),
    ).resolves.toEqual(expect.objectContaining({ assertion, ...lowScoreResult }));
  });

  it('should respect both threshold and explicit pass/fail when both are present', async () => {
    const rubricPrompt = 'Rubric prompt';
    const output = 'Sample output';
    const assertion: Assertion = {
      type: 'llm-rubric',
      value: rubricPrompt,
      threshold: 0.8,
    };

    // Case 1: Pass is true but score is below threshold
    const failingResult = { score: 0.7, reason: 'Score below threshold', pass: true };
    const failingOptions: GradingConfig = {
      rubricPrompt,
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: JSON.stringify(failingResult),
        }),
      },
    };

    await expect(
      matchesLlmRubric(rubricPrompt, output, failingOptions, {}, assertion),
    ).resolves.toEqual(
      expect.objectContaining({
        assertion,
        score: 0.7,
        pass: false,
        reason: 'Score below threshold',
      }),
    );

    // Case 2: Pass is false but score is above threshold
    const passingResult = {
      score: 0.9,
      reason: 'Score above threshold but explicit fail',
      pass: false,
    };
    const passingOptions: GradingConfig = {
      rubricPrompt,
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: JSON.stringify(passingResult),
        }),
      },
    };

    await expect(
      matchesLlmRubric(rubricPrompt, output, passingOptions, {}, assertion),
    ).resolves.toEqual(
      expect.objectContaining({
        assertion,
        score: 0.9,
        pass: false,
        reason: 'Score above threshold but explicit fail',
      }),
    );
  });

  it('should handle edge cases around threshold value', async () => {
    const rubricPrompt = 'Rubric prompt';
    const output = 'Sample output';
    const assertion: Assertion = {
      type: 'llm-rubric',
      value: rubricPrompt,
      threshold: 0.8,
    };

    // Exactly at threshold should pass
    const exactThresholdResult = { score: 0.8, reason: 'Exactly at threshold' };
    const exactOptions: GradingConfig = {
      rubricPrompt,
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: JSON.stringify(exactThresholdResult),
        }),
      },
    };

    await expect(
      matchesLlmRubric(rubricPrompt, output, exactOptions, {}, assertion),
    ).resolves.toEqual(
      expect.objectContaining({
        assertion,
        score: 0.8,
        pass: true,
        reason: 'Exactly at threshold',
      }),
    );

    // Just below threshold should fail
    const justBelowResult = { score: 0.799, reason: 'Just below threshold' };
    const belowOptions: GradingConfig = {
      rubricPrompt,
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: JSON.stringify(justBelowResult),
        }),
      },
    };

    await expect(
      matchesLlmRubric(rubricPrompt, output, belowOptions, {}, assertion),
    ).resolves.toEqual(
      expect.objectContaining({
        assertion,
        score: 0.799,
        pass: false,
        reason: 'Just below threshold',
      }),
    );
  });

  it('should handle missing or invalid scores when threshold is present', async () => {
    const rubricPrompt = 'Rubric prompt';
    const output = 'Sample output';
    const assertion: Assertion = {
      type: 'llm-rubric',
      value: rubricPrompt,
      threshold: 0.8,
    };

    // Missing score should default to pass value
    const missingScoreResult = { pass: true, reason: 'No score provided' };
    const missingScoreOptions: GradingConfig = {
      rubricPrompt,
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: JSON.stringify(missingScoreResult),
        }),
      },
    };

    await expect(
      matchesLlmRubric(rubricPrompt, output, missingScoreOptions, {}, assertion),
    ).resolves.toEqual(
      expect.objectContaining({
        assertion,
        score: 1.0,
        pass: true,
        reason: 'No score provided',
      }),
    );

    // Invalid score type should be handled gracefully
    const invalidScoreResult = { score: 'high', reason: 'Invalid score type', pass: true };
    const invalidScoreOptions: GradingConfig = {
      rubricPrompt,
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: JSON.stringify(invalidScoreResult),
        }),
      },
    };

    await expect(
      matchesLlmRubric(rubricPrompt, output, invalidScoreOptions, {}, assertion),
    ).resolves.toEqual(
      expect.objectContaining({
        assertion,
        score: 1.0,
        pass: true,
        reason: 'Invalid score type',
      }),
    );
  });

  it('should handle string scores', async () => {
    const rubricPrompt = 'Rubric prompt';
    const output = 'Sample output';
    const assertion: Assertion = {
      type: 'llm-rubric',
      value: rubricPrompt,
      threshold: 0.8,
    };

    const stringScoreResult = { score: '0.9', reason: 'String score' };
    const stringScoreOptions: GradingConfig = {
      rubricPrompt,
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: JSON.stringify(stringScoreResult),
        }),
      },
    };

    await expect(
      matchesLlmRubric(rubricPrompt, output, stringScoreOptions, {}, assertion),
    ).resolves.toEqual(
      expect.objectContaining({
        assertion,
        score: 0.9,
        pass: true,
        reason: 'String score',
      }),
    );
  });

  it('should handle string pass values', async () => {
    const rubricPrompt = 'Rubric prompt';
    const output = 'Sample output';
    const assertion: Assertion = {
      type: 'llm-rubric',
      value: rubricPrompt,
      threshold: 0.8,
    };

    const stringPassResult = { reason: 'String pass', pass: 'true' };
    const stringPassOptions: GradingConfig = {
      rubricPrompt,
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: JSON.stringify(stringPassResult),
        }),
      },
    };

    await expect(
      matchesLlmRubric(rubricPrompt, output, stringPassOptions, {}, assertion),
    ).resolves.toEqual(
      expect.objectContaining({
        assertion,
        pass: true,
        reason: 'String pass',
      }),
    );

    const stringFailResult = { reason: 'String fail', pass: 'false' };
    const stringFailOptions: GradingConfig = {
      rubricPrompt,
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: JSON.stringify(stringFailResult),
        }),
      },
    };

    await expect(
      matchesLlmRubric(rubricPrompt, output, stringFailOptions, {}, assertion),
    ).resolves.toEqual(
      expect.objectContaining({
        assertion,
        pass: false,
        reason: 'String fail',
      }),
    );
  });

  it('should load rubric prompt from external file when specified', async () => {
    const rubric = 'Test rubric';
    const llmOutput = 'Test output';
    const grading = {
      rubricPrompt: `file://${mockFilePath}`,
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: JSON.stringify({ pass: true, score: 1, reason: 'Test passed' }),
          tokenUsage: { total: 10, prompt: 5, completion: 5 },
        }),
      },
    };

    const result = await matchesLlmRubric(rubric, llmOutput, grading);

    expect(fs.existsSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join('path', 'to', 'external', 'rubric.txt')),
    );
    expect(fs.readFileSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join('path', 'to', 'external', 'rubric.txt')),
      'utf8',
    );
    expect(grading.provider.callApi).toHaveBeenCalledWith(expect.stringContaining(mockFileContent));
    expect(result).toEqual({
      pass: true,
      score: 1,
      reason: 'Test passed',
      tokensUsed: {
        total: 10,
        prompt: 5,
        completion: 5,
        cached: 0,
        completionDetails: { reasoning: 0, acceptedPrediction: 0, rejectedPrediction: 0 },
      },
    });
  });

  it('should load rubric prompt from js file when specified', async () => {
    const filePath = path.join('path', 'to', 'external', 'file.js');
    const mockImportModule = jest.mocked(importModule);
    const mockFunction = jest.fn(() => 'Do this: {{ rubric }}');
    mockImportModule.mockResolvedValue(mockFunction);

    const rubric = 'Test rubric';
    const llmOutput = 'Test output';
    const grading = {
      rubricPrompt: `file://${filePath}`,
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: JSON.stringify({ pass: true, score: 1, reason: 'Test passed' }),
        }),
      },
    };

    const result = await matchesLlmRubric(rubric, llmOutput, grading);

    await expect(loadFromJavaScriptFile(filePath, undefined, [])).resolves.toBe(
      'Do this: {{ rubric }}',
    );

    expect(grading.provider.callApi).toHaveBeenCalledWith(
      expect.stringContaining('Do this: Test rubric'),
    );
    expect(mockImportModule).toHaveBeenCalledWith(filePath, undefined);

    expect(result).toEqual(
      expect.objectContaining({ pass: true, score: 1, reason: 'Test passed' }),
    );
  });

  it('should throw an error when the external file is not found', async () => {
    jest.mocked(fs.existsSync).mockReturnValue(false);

    const rubric = 'Test rubric';
    const llmOutput = 'Test output';
    const grading = {
      rubricPrompt: `file://${mockFilePath}`,
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: JSON.stringify({ pass: true, score: 1, reason: 'Test passed' }),
          tokenUsage: { total: 10, prompt: 5, completion: 5 },
        }),
      },
    };

    await expect(matchesLlmRubric(rubric, llmOutput, grading)).rejects.toThrow(
      'File does not exist',
    );

    expect(fs.existsSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join('path', 'to', 'external', 'rubric.txt')),
    );
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(grading.provider.callApi).not.toHaveBeenCalled();
  });

  it('should not call remote when rubric prompt is overridden, even if redteam is enabled', async () => {
    const rubric = 'Test rubric';
    const llmOutput = 'Test output';
    const grading = {
      rubricPrompt: 'Custom prompt',
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: JSON.stringify({ pass: true, score: 1, reason: 'Test passed' }),
          tokenUsage: { total: 10, prompt: 5, completion: 5 },
        }),
      },
    };

    // Give it a redteam config
    cliState.config = { redteam: {} };

    await matchesLlmRubric(rubric, llmOutput, grading);

    const { doRemoteGrading } = remoteGrading;
    expect(doRemoteGrading).not.toHaveBeenCalled();

    expect(grading.provider.callApi).toHaveBeenCalledWith(expect.stringContaining('Custom prompt'));
  });

  it('should call remote when redteam is enabled and rubric prompt is not overridden', async () => {
    const rubric = 'Test rubric';
    const llmOutput = 'Test output';
    const grading = {
      provider: {
        id: () => 'test-provider',
        callApi: jest.fn().mockResolvedValue({
          output: JSON.stringify({ pass: true, score: 1, reason: 'Test passed' }),
          tokenUsage: { total: 10, prompt: 5, completion: 5 },
        }),
      },
    };

    // Clear and set up specific mock behavior for this test
    jest.mocked(remoteGrading.doRemoteGrading).mockClear();
    jest.mocked(remoteGrading.doRemoteGrading).mockResolvedValue({
      pass: true,
      score: 1,
      reason: 'Remote grading passed',
    });

    // Import and set up shouldGenerateRemote mock properly
    const { shouldGenerateRemote } = jest.requireMock('../src/redteam/remoteGeneration');
    jest.mocked(shouldGenerateRemote).mockReturnValue(true);

    // Give it a redteam config
    (cliState as any).config = { redteam: {} };

    await matchesLlmRubric(rubric, llmOutput, grading);

    const { doRemoteGrading } = remoteGrading;
    expect(doRemoteGrading).toHaveBeenCalledWith({
      task: 'llm-rubric',
      rubric,
      output: llmOutput,
      vars: {},
    });

    expect(grading.provider.callApi).not.toHaveBeenCalled();
  });
});

describe('matchesFactuality', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetAllMocks();

    // Reset DefaultGradingProvider mock to prevent contamination
    jest.spyOn(DefaultGradingProvider, 'callApi').mockReset();
    jest.spyOn(DefaultGradingProvider, 'callApi').mockResolvedValue({
      output:
        '(A) The submitted answer is a subset of the expert answer and is fully consistent with it.',
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should pass when the factuality check passes with legacy format', async () => {
    const input = 'Input text';
    const expected = 'Expected output';
    const output = 'Sample output';
    const grading = {};

    const mockCallApi = jest.fn().mockResolvedValue({
      output:
        '(A) The submitted answer is a subset of the expert answer and is fully consistent with it.',
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });

    jest.spyOn(DefaultGradingProvider, 'callApi').mockImplementation(mockCallApi);

    await expect(matchesFactuality(input, expected, output, grading)).resolves.toEqual({
      pass: true,
      reason:
        'The submitted answer is a subset of the expert answer and is fully consistent with it.',
      score: 1,
      tokensUsed: expect.objectContaining({
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
      }),
    });
  });

  it('should pass when the factuality check passes with JSON format', async () => {
    const input = 'Input text';
    const expected = 'Expected output';
    const output = 'Sample output';
    const grading = {};

    const mockCallApi = jest.fn().mockResolvedValue({
      output:
        '{"category": "A", "reason": "The submitted answer is a subset of the expert answer and is fully consistent with it."}',
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });

    jest.spyOn(DefaultGradingProvider, 'callApi').mockImplementation(mockCallApi);

    await expect(matchesFactuality(input, expected, output, grading)).resolves.toEqual({
      pass: true,
      reason:
        'The submitted answer is a subset of the expert answer and is fully consistent with it.',
      score: 1,
      tokensUsed: expect.objectContaining({
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
      }),
    });
  });

  it('should fall back to pattern match response', async () => {
    const input = 'Input text';
    const expected = 'Expected output';
    const output = 'Sample output';
    const grading = {};

    const mockCallApi = jest.fn().mockResolvedValue({
      output: '(A) This is a custom reason for category A.',
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });

    jest.spyOn(DefaultGradingProvider, 'callApi').mockImplementation(mockCallApi);

    await expect(matchesFactuality(input, expected, output, grading)).resolves.toEqual({
      pass: true,
      reason: 'This is a custom reason for category A.',
      score: 1,
      tokensUsed: expect.objectContaining({
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
      }),
    });
  });

  it('should fail when the factuality check fails with legacy format', async () => {
    const input = 'Input text';
    const expected = 'Expected output';
    const output = 'Sample output';
    const grading = {};

    const mockCallApi = jest.fn().mockResolvedValue({
      output: '(D) There is a disagreement between the submitted answer and the expert answer.',
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });

    jest.spyOn(DefaultGradingProvider, 'callApi').mockImplementation(mockCallApi);

    await expect(matchesFactuality(input, expected, output, grading)).resolves.toEqual({
      pass: false,
      reason: 'There is a disagreement between the submitted answer and the expert answer.',
      score: 0,
      tokensUsed: expect.objectContaining({
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
      }),
    });
  });

  it('should fail when the factuality check fails with JSON format', async () => {
    const input = 'Input text';
    const expected = 'Expected output';
    const output = 'Sample output';
    const grading = {};

    const mockCallApi = jest.fn().mockResolvedValue({
      output:
        '{"category": "D", "reason": "There is a disagreement between the submitted answer and the expert answer."}',
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });

    jest.spyOn(DefaultGradingProvider, 'callApi').mockImplementation(mockCallApi);

    await expect(matchesFactuality(input, expected, output, grading)).resolves.toEqual({
      pass: false,
      reason: 'There is a disagreement between the submitted answer and the expert answer.',
      score: 0,
      tokensUsed: expect.objectContaining({
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
      }),
    });
  });

  it('should use the overridden factuality grading config', async () => {
    const input = 'Input text';
    const expected = 'Expected output';
    const output = 'Sample output';
    const grading = {
      factuality: {
        subset: 0.8,
        superset: 0.9,
        agree: 1,
        disagree: 0,
        differButFactual: 0.7,
      },
    };

    const mockCallApi = jest.fn().mockResolvedValue({
      output:
        '{"category": "A", "reason": "The submitted answer is a subset of the expert answer and is fully consistent with it."}',
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });

    jest.spyOn(DefaultGradingProvider, 'callApi').mockImplementation(mockCallApi);

    await expect(matchesFactuality(input, expected, output, grading)).resolves.toEqual({
      pass: true,
      reason:
        'The submitted answer is a subset of the expert answer and is fully consistent with it.',
      score: 0.8,
      tokensUsed: expect.objectContaining({
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
      }),
    });
  });

  it('should use category description as fallback when no reason is provided in JSON', async () => {
    const input = 'Input text';
    const expected = 'Expected output';
    const output = 'Sample output';
    const grading = {};

    const mockCallApi = jest.fn().mockResolvedValue({
      output: '{"category": "A"}',
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });

    jest.spyOn(DefaultGradingProvider, 'callApi').mockImplementation(mockCallApi);

    await expect(matchesFactuality(input, expected, output, grading)).resolves.toEqual({
      pass: true,
      reason:
        'Category A: The submitted answer is a subset of the expert answer and is fully consistent with it.',
      score: 1,
      tokensUsed: expect.objectContaining({
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
      }),
    });
  });

  it('should fail when JSON has invalid category', async () => {
    const input = 'Input text';
    const expected = 'Expected output';
    const output = 'Sample output';
    const grading = {};

    const mockCallApi = jest.fn().mockResolvedValue({
      output: '{"category": "Z", "reason": "Invalid category"}',
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });

    jest.spyOn(DefaultGradingProvider, 'callApi').mockImplementation(mockCallApi);

    await expect(matchesFactuality(input, expected, output, grading)).resolves.toEqual({
      pass: false,
      score: 0,
      reason: 'Invalid category value: Z',
      tokensUsed: expect.objectContaining({
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
      }),
    });
  });

  it('should use custom prompt override when provided', async () => {
    const input = 'Input text';
    const expected = 'Expected output';
    const output = 'Sample output';

    const customPrompt = JSON.stringify([
      {
        role: 'system',
        content: `You are comparing a submitted answer to an expert answer on a given question. Here is the data:
[BEGIN DATA]
************
[Question]: {{input}}
************
[Expert]: {{ideal}}
************
[Submission]: {{completion}}
************
[END DATA]

Compare the factual content of the submitted answer with the expert answer. Ignore any differences in style, grammar, or punctuation.
The submitted answer may either be a subset or superset of the expert answer, or it may conflict with it. Determine which case applies. Answer the question by selecting one of the following options:
(A) The submitted answer is a subset of the expert answer and is fully consistent with it.
(B) The submitted answer is a superset of the expert answer and is fully consistent with it.
(C) The submitted answer contains all the same details as the expert answer.
(D) There is a disagreement between the submitted answer and the expert answer.
(E) The answers differ, but these differences don't matter from the perspective of factuality.`,
      },
    ]);

    const mockCallApi = jest.fn().mockResolvedValue({
      output: '(B) The submitted answer is a superset of the expert answer.',
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });

    const grading = {
      rubricPrompt: customPrompt,
      provider: {
        id: () => 'test-provider',
        callApi: mockCallApi,
      },
    };

    const result = await matchesFactuality(input, expected, output, grading);

    expect(result).toEqual({
      pass: true,
      reason: 'The submitted answer is a superset of the expert answer.',
      score: 1,
      tokensUsed: expect.objectContaining({
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
      }),
    });

    // Verify the custom prompt was used
    expect(mockCallApi).toHaveBeenCalledWith(
      expect.stringContaining(
        'The submitted answer may either be a subset or superset of the expert answer',
      ),
    );
  });

  it('should throw an error when an error occurs', async () => {
    const input = 'Input text';
    const expected = 'Expected output';
    const output = 'Sample output';
    const grading = {};

    jest.spyOn(DefaultGradingProvider, 'callApi').mockImplementation(() => {
      throw new Error('An error occurred');
    });

    await expect(matchesFactuality(input, expected, output, grading)).rejects.toThrow(
      'An error occurred',
    );
  });

  it('should use Nunjucks templating when PROMPTFOO_DISABLE_TEMPLATING is set', async () => {
    process.env.PROMPTFOO_DISABLE_TEMPLATING = 'true';
    const input = 'Input {{ var }}';
    const expected = 'Expected {{ var }}';
    const output = 'Output {{ var }}';
    const grading: GradingConfig = {
      provider: DefaultGradingProvider,
    };

    jest.spyOn(DefaultGradingProvider, 'callApi').mockResolvedValue({
      output: '{"category": "A", "reason": "The submitted answer is correct."}',
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });

    await matchesFactuality(input, expected, output, grading);

    expect(DefaultGradingProvider.callApi).toHaveBeenCalledWith(
      expect.stringContaining('Input {{ var }}'),
    );
    expect(DefaultGradingProvider.callApi).toHaveBeenCalledWith(
      expect.stringContaining('Expected {{ var }}'),
    );
    expect(DefaultGradingProvider.callApi).toHaveBeenCalledWith(
      expect.stringContaining('Output {{ var }}'),
    );

    process.env.PROMPTFOO_DISABLE_TEMPLATING = undefined;
  });
});

describe('matchesClosedQa', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetAllMocks();

    // Reset DefaultGradingProvider mock to prevent contamination
    jest.spyOn(DefaultGradingProvider, 'callApi').mockReset();
    jest.spyOn(DefaultGradingProvider, 'callApi').mockResolvedValue({
      output: 'foo \n \n bar\n Y Y \n',
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should pass when the closed QA check passes', async () => {
    const input = 'Input text';
    const expected = 'Expected output';
    const output = 'Sample output';
    const grading = {};

    jest.spyOn(DefaultGradingProvider, 'callApi').mockResolvedValueOnce({
      output: 'foo \n \n bar\n Y Y \n',
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });

    await expect(matchesClosedQa(input, expected, output, grading)).resolves.toEqual({
      pass: true,
      reason: 'The submission meets the criterion',
      score: 1,
      tokensUsed: {
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
        cached: expect.any(Number),
        completionDetails: expect.any(Object),
      },
    });
  });

  it('should fail when the closed QA check fails', async () => {
    const input = 'Input text';
    const expected = 'Expected output';
    const output = 'Sample output';
    const grading = {};

    jest.spyOn(DefaultGradingProvider, 'callApi').mockResolvedValueOnce({
      output: 'foo bar N \n',
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });

    await expect(matchesClosedQa(input, expected, output, grading)).resolves.toEqual({
      pass: false,
      reason: 'The submission does not meet the criterion:\nfoo bar N \n',
      score: 0,
      tokensUsed: {
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
        cached: expect.any(Number),
        completionDetails: expect.any(Object),
      },
    });
  });

  it('should throw an error when an error occurs', async () => {
    const input = 'Input text';
    const expected = 'Expected output';
    const output = 'Sample output';
    const grading = {};

    jest.spyOn(DefaultGradingProvider, 'callApi').mockImplementation(() => {
      throw new Error('An error occurred');
    });

    await expect(matchesClosedQa(input, expected, output, grading)).rejects.toThrow(
      'An error occurred',
    );
  });

  it('should handle input, criteria, and completion that need escaping', async () => {
    const input = 'Input "text" with \\ escape characters and \\"nested\\" escapes';
    const expected = 'Expected "output" with \\\\ escape characters and \\"nested\\" escapes';
    const output = 'Sample "output" with \\\\ escape characters and \\"nested\\" escapes';
    const grading = {};

    let isJson = false;
    jest.spyOn(DefaultGradingProvider, 'callApi').mockImplementation((prompt) => {
      try {
        JSON.parse(prompt);
        isJson = true;
      } catch {
        isJson = false;
      }
      return Promise.resolve({
        output: 'foo \n \n bar\n Y Y',
        tokenUsage: { total: 10, prompt: 5, completion: 5 },
      });
    });
    await expect(matchesClosedQa(input, expected, output, grading)).resolves.toEqual({
      pass: true,
      reason: 'The submission meets the criterion',
      score: 1,
      tokensUsed: {
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
        cached: expect.any(Number),
        completionDetails: expect.any(Object),
      },
    });
    expect(isJson).toBeTruthy();
  });

  it('should use Nunjucks templating when PROMPTFOO_DISABLE_TEMPLATING is set', async () => {
    process.env.PROMPTFOO_DISABLE_TEMPLATING = 'true';
    const input = 'Input {{ var }}';
    const expected = 'Expected {{ var }}';
    const output = 'Output {{ var }}';
    const grading: GradingConfig = {
      provider: DefaultGradingProvider,
    };

    jest.spyOn(DefaultGradingProvider, 'callApi').mockResolvedValue({
      output: 'Y',
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });

    await matchesClosedQa(input, expected, output, grading);

    expect(DefaultGradingProvider.callApi).toHaveBeenCalledWith(
      expect.stringContaining('Input {{ var }}'),
    );
    expect(DefaultGradingProvider.callApi).toHaveBeenCalledWith(
      expect.stringContaining('Expected {{ var }}'),
    );
    expect(DefaultGradingProvider.callApi).toHaveBeenCalledWith(
      expect.stringContaining('Output {{ var }}'),
    );

    process.env.PROMPTFOO_DISABLE_TEMPLATING = undefined;
  });
});

describe('getGradingProvider', () => {
  it('should return the correct provider when provider is a string', async () => {
    const provider = await getGradingProvider(
      'text',
      'openai:chat:gpt-4o-mini-foobar',
      DefaultGradingProvider,
    );
    // ok for this not to match exactly when the string is parsed
    expect(provider?.id()).toBe('openai:gpt-4o-mini-foobar');
  });

  it('should return the correct provider when provider is an ApiProvider', async () => {
    const provider = await getGradingProvider(
      'embedding',
      DefaultEmbeddingProvider,
      DefaultGradingProvider,
    );
    expect(provider).toBe(DefaultEmbeddingProvider);
  });

  it('should return the correct provider when provider is ProviderOptions', async () => {
    const providerOptions = {
      id: 'openai:chat:gpt-4o-mini-foobar',
      config: {
        apiKey: 'abc123',
        temperature: 3.1415926,
      },
    };
    const provider = await getGradingProvider('text', providerOptions, DefaultGradingProvider);
    expect(provider?.id()).toBe('openai:chat:gpt-4o-mini-foobar');
  });

  it('should return the default provider when provider is not provided', async () => {
    const provider = await getGradingProvider('text', undefined, DefaultGradingProvider);
    expect(provider).toBe(DefaultGradingProvider);
  });
});

describe('getAndCheckProvider', () => {
  it('should return the default provider when provider is not defined', async () => {
    await expect(
      getAndCheckProvider('text', undefined, DefaultGradingProvider, 'test check'),
    ).resolves.toBe(DefaultGradingProvider);
  });

  it('should return the default provider when provider does not support type', async () => {
    const provider = {
      id: () => 'test-provider',
      callApi: () => Promise.resolve({ output: 'test' }),
    };
    await expect(
      getAndCheckProvider('embedding', provider, DefaultEmbeddingProvider, 'test check'),
    ).resolves.toBe(DefaultEmbeddingProvider);
  });

  it('should return the provider if it implements the required method', async () => {
    const provider = {
      id: () => 'test-provider',
      callApi: () => Promise.resolve({ output: 'test' }),
      callEmbeddingApi: () => Promise.resolve({ embedding: [] }),
    };
    const result = await getAndCheckProvider(
      'embedding',
      provider,
      DefaultEmbeddingProvider,
      'test check',
    );
    expect(result).toBe(provider);
  });

  it('should return the default provider when no provider is specified', async () => {
    const provider = await getGradingProvider('text', undefined, DefaultGradingProvider);
    expect(provider).toBe(DefaultGradingProvider);
  });

  it('should return a specific provider when a provider id is specified', async () => {
    const provider = await getGradingProvider('text', 'openai:chat:foo', DefaultGradingProvider);
    // loadApiProvider removes `chat` from the id
    expect(provider?.id()).toBe('openai:foo');
  });

  it('should return a provider from ApiProvider when specified', async () => {
    const providerOptions: ApiProvider = {
      id: () => 'custom-provider',
      callApi: async () => ({}),
    };
    const provider = await getGradingProvider('text', providerOptions, DefaultGradingProvider);
    expect(provider?.id()).toBe('custom-provider');
  });

  it('should return a provider from ProviderTypeMap when specified', async () => {
    const providerTypeMap: ProviderTypeMap = {
      text: {
        id: 'openai:chat:foo',
      },
      embedding: {
        id: 'openai:embedding:bar',
      },
    };
    const provider = await getGradingProvider('text', providerTypeMap, DefaultGradingProvider);
    expect(provider?.id()).toBe('openai:chat:foo');
  });

  it('should return a provider from ProviderTypeMap with basic strings', async () => {
    const providerTypeMap: ProviderTypeMap = {
      text: 'openai:chat:foo',
      embedding: 'openai:embedding:bar',
    };
    const provider = await getGradingProvider('text', providerTypeMap, DefaultGradingProvider);
    expect(provider?.id()).toBe('openai:foo');
  });

  it('should throw an error when the provider does not match the type', async () => {
    const providerTypeMap: ProviderTypeMap = {
      embedding: {
        id: 'openai:embedding:foo',
      },
    };
    await expect(
      getGradingProvider('text', providerTypeMap, DefaultGradingProvider),
    ).rejects.toThrow(
      new Error(
        `Invalid provider definition for output type 'text': ${JSON.stringify(
          providerTypeMap,
          null,
          2,
        )}`,
      ),
    );
  });
});

describe('matchesAnswerRelevance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetAllMocks();

    // Reset DefaultGradingProvider and DefaultEmbeddingProvider mocks to prevent contamination
    jest.spyOn(DefaultGradingProvider, 'callApi').mockReset();
    jest.spyOn(DefaultEmbeddingProvider, 'callEmbeddingApi').mockReset();

    // Set up robust default mocks that work for most tests
    jest.spyOn(DefaultGradingProvider, 'callApi').mockResolvedValue({
      output: 'foobar',
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });
    jest.spyOn(DefaultEmbeddingProvider, 'callEmbeddingApi').mockResolvedValue({
      embedding: [1, 0, 0],
      tokenUsage: { total: 5, prompt: 2, completion: 3 },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should pass when the relevance score is above the threshold', async () => {
    const input = 'Input text';
    const output = 'Sample output';
    const threshold = 0.5;

    const mockCallApi = jest.spyOn(DefaultGradingProvider, 'callApi');
    mockCallApi.mockImplementation(() => {
      return Promise.resolve({
        output: 'foobar',
        tokenUsage: { total: 10, prompt: 5, completion: 5 },
      });
    });

    const mockCallEmbeddingApi = jest.spyOn(DefaultEmbeddingProvider, 'callEmbeddingApi');
    mockCallEmbeddingApi.mockImplementation(function (this: OpenAiEmbeddingProvider) {
      return Promise.resolve({
        embedding: [1, 0, 0],
        tokenUsage: { total: 5, prompt: 2, completion: 3 },
      });
    });

    await expect(matchesAnswerRelevance(input, output, threshold)).resolves.toEqual({
      pass: true,
      reason: 'Relevance 1.00 is greater than threshold 0.5',
      score: 1,
      tokensUsed: {
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
        cached: expect.any(Number),
        completionDetails: expect.any(Object),
      },
    });
    expect(mockCallApi).toHaveBeenCalledWith(
      expect.stringContaining(ANSWER_RELEVANCY_GENERATE.slice(0, 50)),
    );
    expect(mockCallEmbeddingApi).toHaveBeenCalledWith('Input text');
  });

  it('should fail when the relevance score is below the threshold', async () => {
    const input = 'Input text';
    const output = 'Different output';
    const threshold = 0.5;

    const mockCallApi = jest.spyOn(DefaultGradingProvider, 'callApi');
    mockCallApi.mockImplementation((text) => {
      return Promise.resolve({
        output: text,
        tokenUsage: { total: 10, prompt: 5, completion: 5 },
      });
    });

    const mockCallEmbeddingApi = jest.spyOn(DefaultEmbeddingProvider, 'callEmbeddingApi');
    mockCallEmbeddingApi.mockImplementation((text) => {
      if (text.includes('Input text')) {
        return Promise.resolve({
          embedding: [1, 0, 0],
          tokenUsage: { total: 5, prompt: 2, completion: 3 },
        });
      } else if (text.includes('Different output')) {
        return Promise.resolve({
          embedding: [0, 1, 0],
          tokenUsage: { total: 5, prompt: 2, completion: 3 },
        });
      }
      return Promise.reject(new Error(`Unexpected input ${text}`));
    });

    await expect(matchesAnswerRelevance(input, output, threshold)).resolves.toEqual({
      pass: false,
      reason: 'Relevance 0.00 is less than threshold 0.5',
      score: 0,
      tokensUsed: {
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
        cached: expect.any(Number),
        completionDetails: expect.any(Object),
      },
    });
    expect(mockCallApi).toHaveBeenCalledWith(
      expect.stringContaining(ANSWER_RELEVANCY_GENERATE.slice(0, 50)),
    );
    expect(mockCallEmbeddingApi).toHaveBeenCalledWith(
      expect.stringContaining(ANSWER_RELEVANCY_GENERATE.slice(0, 50)),
    );
  });

  it('tracks token usage for successful calls', async () => {
    const input = 'Input text';
    const output = 'Sample output';
    const threshold = 0.5;

    const result = await matchesAnswerRelevance(input, output, threshold);

    // Verify token usage is properly accumulated from all API calls
    expect(result.tokensUsed?.total).toBeGreaterThan(0);
    expect(result.tokensUsed?.prompt).toBeGreaterThan(0);
    expect(result.tokensUsed?.completion).toBeGreaterThan(0);
    expect(result.tokensUsed?.total).toBe(
      (result.tokensUsed?.prompt || 0) + (result.tokensUsed?.completion || 0),
    );

    // Should accumulate from multiple calls: 3 text generations + 1 input embedding + 3 candidate embeddings = 7 calls
    // With mocked values: 3*10 + 1*5 + 3*5 = 50 total tokens
    expect(result.tokensUsed?.total).toBe(50);
    expect(result.tokensUsed?.cached).toBe(0);
    expect(result.tokensUsed?.completionDetails).toBeDefined();
  });
});

describe('matchesClassification', () => {
  class TestGrader implements ApiProvider {
    async callApi(): Promise<ProviderResponse> {
      throw new Error('Not implemented');
    }

    async callClassificationApi(): Promise<ProviderClassificationResponse> {
      return {
        classification: {
          classA: 0.6,
          classB: 0.5,
        },
      };
    }

    id(): string {
      return 'TestClassificationProvider';
    }
  }

  it('should pass when the classification score is above the threshold', async () => {
    const expected = 'classA';
    const output = 'Sample output';
    const threshold = 0.5;

    const grader = new TestGrader();
    const grading: GradingConfig = {
      provider: grader,
    };

    await expect(matchesClassification(expected, output, threshold, grading)).resolves.toEqual({
      pass: true,
      reason: `Classification ${expected} has score 0.60 >= ${threshold}`,
      score: 0.6,
    });
  });

  it('should fail when the classification score is below the threshold', async () => {
    const expected = 'classA';
    const output = 'Different output';
    const threshold = 0.9;

    const grader = new TestGrader();
    const grading: GradingConfig = {
      provider: grader,
    };

    await expect(matchesClassification(expected, output, threshold, grading)).resolves.toEqual({
      pass: false,
      reason: `Classification ${expected} has score 0.60 < ${threshold}`,
      score: 0.6,
    });
  });

  it('should pass when the maximum classification score is above the threshold with undefined expected', async () => {
    const expected = undefined;
    const output = 'Sample output';
    const threshold = 0.55;

    const grader = new TestGrader();
    const grading: GradingConfig = {
      provider: grader,
    };

    await expect(matchesClassification(expected, output, threshold, grading)).resolves.toEqual({
      pass: true,
      reason: `Maximum classification score 0.60 >= ${threshold}`,
      score: 0.6,
    });
  });

  it('should use the overridden classification grading config', async () => {
    const expected = 'classA';
    const output = 'Sample output';
    const threshold = 0.5;

    const grading: GradingConfig = {
      provider: {
        id: 'hf:text-classification:foobar',
      },
    };

    const mockCallApi = jest.spyOn(
      HuggingfaceTextClassificationProvider.prototype,
      'callClassificationApi',
    );
    mockCallApi.mockImplementation(function (this: HuggingfaceTextClassificationProvider) {
      return Promise.resolve({
        classification: { [expected]: 0.6 },
      });
    });

    await expect(matchesClassification(expected, output, threshold, grading)).resolves.toEqual({
      pass: true,
      reason: `Classification ${expected} has score 0.60 >= ${threshold}`,
      score: 0.6,
    });
    expect(mockCallApi).toHaveBeenCalledWith('Sample output');

    mockCallApi.mockRestore();
  });
});

describe('matchesContextRelevance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetAllMocks();

    // Reset DefaultGradingProvider mock to prevent contamination
    jest.spyOn(DefaultGradingProvider, 'callApi').mockReset();
    jest.spyOn(DefaultGradingProvider, 'callApi').mockResolvedValue({
      output: 'foo\nbar\nbaz Insufficient Information\n',
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should pass when the relevance score is above the threshold', async () => {
    const input = 'Input text';
    const context = 'Context text';
    const threshold = 0.5;

    const mockCallApi = jest.fn().mockImplementation(() => {
      return Promise.resolve({
        output: 'foo\nbar\nbaz Insufficient Information\n',
        tokenUsage: { total: 10, prompt: 5, completion: 5 },
      });
    });

    jest.spyOn(DefaultGradingProvider, 'callApi').mockImplementation(mockCallApi);

    await expect(matchesContextRelevance(input, context, threshold)).resolves.toEqual({
      pass: true,
      reason: 'Relevance 0.67 is >= 0.5',
      score: expect.closeTo(0.67, 0.01),
      tokensUsed: {
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
        cached: expect.any(Number),
        completionDetails: expect.any(Object),
      },
    });
  });

  it('should fail when the relevance score is below the threshold', async () => {
    const input = 'Input text';
    const context = 'Context text';
    const threshold = 0.9;

    const mockCallApi = jest.fn().mockImplementation(() => {
      return Promise.resolve({
        output: 'foo\nbar\nbaz Insufficient Information',
        tokenUsage: { total: 10, prompt: 5, completion: 5 },
      });
    });

    jest.spyOn(DefaultGradingProvider, 'callApi').mockImplementation(mockCallApi);

    await expect(matchesContextRelevance(input, context, threshold)).resolves.toEqual({
      pass: false,
      reason: 'Relevance 0.67 is < 0.9',
      score: expect.closeTo(0.67, 0.01),
      tokensUsed: {
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
        cached: expect.any(Number),
        completionDetails: expect.any(Object),
      },
    });
  });
});

describe('matchesContextFaithfulness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetAllMocks();

    // Reset DefaultGradingProvider mock to prevent contamination
    jest.spyOn(DefaultGradingProvider, 'callApi').mockReset();
    jest
      .spyOn(DefaultGradingProvider, 'callApi')
      .mockImplementationOnce(() => {
        return Promise.resolve({
          output: 'Statement 1\nStatement 2\nStatement 3\n',
          tokenUsage: { total: 10, prompt: 5, completion: 5 },
        });
      })
      .mockImplementationOnce(() => {
        return Promise.resolve({
          output: 'Final verdict for each statement in order: Yes. No. Yes.',
          tokenUsage: { total: 10, prompt: 5, completion: 5 },
        });
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should pass when the faithfulness score is above the threshold', async () => {
    const query = 'Query text';
    const output = 'Output text';
    const context = 'Context text';
    const threshold = 0.5;

    const mockCallApi = jest
      .fn()
      .mockImplementationOnce(() => {
        return Promise.resolve({
          output: 'Statement 1\nStatement 2\nStatement 3\n',
          tokenUsage: { total: 10, prompt: 5, completion: 5 },
        });
      })
      .mockImplementationOnce(() => {
        return Promise.resolve({
          output: 'Final verdict for each statement in order: Yes. No. Yes.',
          tokenUsage: { total: 10, prompt: 5, completion: 5 },
        });
      });

    jest.spyOn(DefaultGradingProvider, 'callApi').mockImplementation(mockCallApi);

    await expect(matchesContextFaithfulness(query, output, context, threshold)).resolves.toEqual({
      pass: true,
      reason: 'Faithfulness 0.67 is >= 0.5',
      score: expect.closeTo(0.67, 0.01),
      tokensUsed: {
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
        cached: expect.any(Number),
        completionDetails: expect.any(Object),
      },
    });
  });

  it('should fail when the faithfulness score is below the threshold', async () => {
    const query = 'Query text';
    const output = 'Output text';
    const context = 'Context text';
    const threshold = 0.7;

    const mockCallApi = jest
      .fn()
      .mockImplementationOnce(() => {
        return Promise.resolve({
          output: 'Statement 1\nStatement 2\nStatement 3',
          tokenUsage: { total: 10, prompt: 5, completion: 5 },
        });
      })
      .mockImplementationOnce(() => {
        return Promise.resolve({
          output: 'Final verdict for each statement in order: Yes. Yes. No.',
          tokenUsage: { total: 10, prompt: 5, completion: 5 },
        });
      });

    jest.spyOn(DefaultGradingProvider, 'callApi').mockImplementation(mockCallApi);

    await expect(matchesContextFaithfulness(query, output, context, threshold)).resolves.toEqual({
      pass: false,
      reason: 'Faithfulness 0.67 is < 0.7',
      score: expect.closeTo(0.67, 0.01),
      tokensUsed: {
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
        cached: expect.any(Number),
        completionDetails: expect.any(Object),
      },
    });
  });

  it('tracks token usage for multiple API calls', async () => {
    const query = 'Query text';
    const output = 'Output text';
    const context = 'Context text';
    const threshold = 0.5;

    const result = await matchesContextFaithfulness(query, output, context, threshold);

    expect(result.tokensUsed).toEqual({
      total: 20, // 10 from first call + 10 from second call
      prompt: 10, // 5 from first call + 5 from second call
      completion: 10, // 5 from first call + 5 from second call
      cached: 0,
      completionDetails: expect.any(Object),
    });
  });
});

describe('matchesContextRecall', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetAllMocks();

    // Reset DefaultGradingProvider mock to prevent contamination
    jest.spyOn(DefaultGradingProvider, 'callApi').mockReset();
    jest.spyOn(DefaultGradingProvider, 'callApi').mockResolvedValue({
      output: 'foo [Attributed]\nbar [Not attributed]\nbaz [Attributed]\n',
      tokenUsage: { total: 10, prompt: 5, completion: 5 },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should pass when the recall score is above the threshold', async () => {
    const context = 'Context text';
    const groundTruth = 'Ground truth text';
    const threshold = 0.5;

    const mockCallApi = jest.fn().mockImplementation(() => {
      return Promise.resolve({
        output: 'foo [Attributed]\nbar [Not attributed]\nbaz [Attributed]\n',
        tokenUsage: { total: 10, prompt: 5, completion: 5 },
      });
    });

    jest.spyOn(DefaultGradingProvider, 'callApi').mockImplementation(mockCallApi);

    await expect(matchesContextRecall(context, groundTruth, threshold)).resolves.toEqual({
      pass: true,
      reason: 'Recall 0.67 is >= 0.5',
      score: expect.closeTo(0.67, 0.01),
      tokensUsed: {
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
        cached: expect.any(Number),
        completionDetails: expect.any(Object),
      },
    });
  });

  it('should fail when the recall score is below the threshold', async () => {
    const context = 'Context text';
    const groundTruth = 'Ground truth text';
    const threshold = 0.9;

    const mockCallApi = jest.fn().mockImplementation(() => {
      return Promise.resolve({
        output: 'foo [Attributed]\nbar [Not attributed]\nbaz [Attributed]',
        tokenUsage: { total: 10, prompt: 5, completion: 5 },
      });
    });

    jest.spyOn(DefaultGradingProvider, 'callApi').mockImplementation(mockCallApi);

    await expect(matchesContextRecall(context, groundTruth, threshold)).resolves.toEqual({
      pass: false,
      reason: 'Recall 0.67 is < 0.9',
      score: expect.closeTo(0.67, 0.01),
      tokensUsed: {
        total: expect.any(Number),
        prompt: expect.any(Number),
        completion: expect.any(Number),
        cached: expect.any(Number),
        completionDetails: expect.any(Object),
      },
    });
  });
});

describe('matchesModeration', () => {
  const mockModerationResponse = {
    flags: [],
    tokenUsage: { total: 5, prompt: 2, completion: 3 },
  };

  beforeEach(() => {
    // Clear all environment variables
    delete process.env.OPENAI_API_KEY;
    delete process.env.REPLICATE_API_KEY;
    delete process.env.REPLICATE_API_TOKEN;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should skip moderation when assistant response is empty', async () => {
    const openAiSpy = jest
      .spyOn(OpenAiModerationProvider.prototype, 'callModerationApi')
      .mockResolvedValue(mockModerationResponse);

    const result = await matchesModeration({
      userPrompt: 'test prompt',
      assistantResponse: '',
    });

    expect(result).toEqual({
      pass: true,
      score: 1,
      reason: expect.any(String),
    });
    expect(openAiSpy).not.toHaveBeenCalled();
  });

  it('should use OpenAI when OPENAI_API_KEY is present', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const openAiSpy = jest
      .spyOn(OpenAiModerationProvider.prototype, 'callModerationApi')
      .mockResolvedValue(mockModerationResponse);

    await matchesModeration({
      userPrompt: 'test prompt',
      assistantResponse: 'test response',
    });

    expect(openAiSpy).toHaveBeenCalledWith('test prompt', 'test response');
  });

  it('should fallback to Replicate when only REPLICATE_API_KEY is present', async () => {
    process.env.REPLICATE_API_KEY = 'test-key';
    const replicateSpy = jest
      .spyOn(ReplicateModerationProvider.prototype, 'callModerationApi')
      .mockResolvedValue(mockModerationResponse);

    await matchesModeration({
      userPrompt: 'test prompt',
      assistantResponse: 'test response',
    });

    expect(replicateSpy).toHaveBeenCalledWith('test prompt', 'test response');
  });

  it('should respect provider override in grading config', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const replicateSpy = jest
      .spyOn(ReplicateModerationProvider.prototype, 'callModerationApi')
      .mockResolvedValue(mockModerationResponse);

    await matchesModeration(
      {
        userPrompt: 'test prompt',
        assistantResponse: 'test response',
      },
      {
        provider: LLAMA_GUARD_REPLICATE_PROVIDER,
      },
    );

    expect(replicateSpy).toHaveBeenCalledWith('test prompt', 'test response');
  });
});

describe('tryParse and renderLlmRubricPrompt', () => {
  let tryParse: (content: string | null | undefined) => any;

  beforeAll(async () => {
    const context: { capturedFn: null | Function } = { capturedFn: null };

    await renderLlmRubricPrompt('{"test":"value"}', {
      __capture(fn: Function) {
        context.capturedFn = fn;
        return 'captured';
      },
    });

    tryParse = function (content: string | null | undefined) {
      try {
        if (content === null || content === undefined) {
          return content;
        }
        return JSON.parse(content);
      } catch {}
      return content;
    };
  });

  it('should parse valid JSON', () => {
    const input = '{"key": "value"}';
    expect(tryParse(input)).toEqual({ key: 'value' });
  });

  it('should return original string for invalid JSON', () => {
    const input = 'not json';
    expect(tryParse(input)).toBe('not json');
  });

  it('should handle empty string', () => {
    const input = '';
    expect(tryParse(input)).toBe('');
  });

  it('should handle null and undefined', () => {
    expect(tryParse(null)).toBeNull();
    expect(tryParse(undefined)).toBeUndefined();
  });

  it('should render strings inside JSON objects', async () => {
    const template = '{"role": "user", "content": "Hello {{name}}"}';
    const result = await renderLlmRubricPrompt(template, { name: 'World' });
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ role: 'user', content: 'Hello World' });
  });

  it('should preserve JSON structure while rendering only strings', async () => {
    const template = '{"nested": {"text": "{{var}}", "number": 42}}';
    const result = await renderLlmRubricPrompt(template, { var: 'test' });
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ nested: { text: 'test', number: 42 } });
  });

  it('should handle non-JSON templates with legacy rendering', async () => {
    const template = 'Hello {{name}}';
    const result = await renderLlmRubricPrompt(template, { name: 'World' });
    expect(result).toBe('Hello World');
  });

  it('should handle complex objects in context', async () => {
    const template = '{"text": "{{object}}"}';
    const complexObject = { foo: 'bar', baz: [1, 2, 3] };
    const result = await renderLlmRubricPrompt(template, { object: complexObject });
    const parsed = JSON.parse(result);
    expect(typeof parsed.text).toBe('string');
    // With our fix, this should now be stringified JSON instead of [object Object]
    expect(parsed.text).toBe(JSON.stringify(complexObject));
  });

  it('should properly stringify objects', async () => {
    const template = 'Source Text:\n{{input}}';
    // Create objects that would typically cause the [object Object] issue
    const objects = [
      { name: 'Object 1', properties: { color: 'red', size: 'large' } },
      { name: 'Object 2', properties: { color: 'blue', size: 'small' } },
    ];

    const result = await renderLlmRubricPrompt(template, { input: objects });

    // With our fix, this should properly stringify the objects
    expect(result).not.toContain('[object Object]');
    expect(result).toContain(JSON.stringify(objects[0]));
    expect(result).toContain(JSON.stringify(objects[1]));
  });

  it('should handle mixed arrays of objects and primitives', async () => {
    const template = 'Items: {{items}}';
    const mixedArray = ['string item', { name: 'Object item' }, 42, [1, 2, 3]];

    const result = await renderLlmRubricPrompt(template, { items: mixedArray });

    // Objects in array should be stringified
    expect(result).not.toContain('[object Object]');
    expect(result).toContain('string item');
    expect(result).toContain(JSON.stringify({ name: 'Object item' }));
    expect(result).toContain('42');
    expect(result).toContain(JSON.stringify([1, 2, 3]));
  });

  it('should render arrays of objects correctly', async () => {
    const template = '{"items": [{"name": "{{name1}}"}, {"name": "{{name2}}"}]}';
    const result = await renderLlmRubricPrompt(template, { name1: 'Alice', name2: 'Bob' });
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({
      items: [{ name: 'Alice' }, { name: 'Bob' }],
    });
  });

  it('should handle multiline strings', async () => {
    const template = `{"content": "Line 1\\nLine {{number}}\\nLine 3"}`;
    const result = await renderLlmRubricPrompt(template, { number: '2' });
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({
      content: 'Line 1\nLine 2\nLine 3',
    });
  });

  it('should handle nested templates', async () => {
    const template = '{"outer": "{{value1}}", "inner": {"value": "{{value2}}"}}';
    const result = await renderLlmRubricPrompt(template, {
      value1: 'outer value',
      value2: 'inner value',
    });
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({
      outer: 'outer value',
      inner: { value: 'inner value' },
    });
  });

  it('should handle escaping in JSON strings', async () => {
    const template = '{"content": "This needs \\"escaping\\" and {{var}} too"}';
    const result = await renderLlmRubricPrompt(template, { var: 'var with "quotes"' });
    const parsed = JSON.parse(result);
    expect(parsed.content).toBe('This needs "escaping" and var with "quotes" too');
  });

  it('should work with nested arrays and objects', async () => {
    const template = JSON.stringify({
      role: 'system',
      content: 'Process this: {{input}}',
      config: {
        options: [
          { id: 1, label: '{{option1}}' },
          { id: 2, label: '{{option2}}' },
        ],
      },
    });

    const evalResult = await renderLlmRubricPrompt(template, {
      input: 'test input',
      option1: 'First Option',
      option2: 'Second Option',
    });

    const parsed = JSON.parse(evalResult);
    expect(parsed.content).toBe('Process this: test input');
    expect(parsed.config.options[0].label).toBe('First Option');
    expect(parsed.config.options[1].label).toBe('Second Option');
  });

  it('should handle rendering statements with join filter', async () => {
    const statements = ['Statement 1', 'Statement 2', 'Statement 3'];
    const template = 'statements:\n{{statements|join("\\n")}}';
    const result = await renderLlmRubricPrompt(template, { statements });

    const expected = 'statements:\nStatement 1\nStatement 2\nStatement 3';
    expect(result).toBe(expected);
  });

  it('should stringify objects in arrays', async () => {
    const template = 'Items: {{items}}';
    const items = [{ name: 'Item 1', price: 10 }, 'string item', { name: 'Item 2', price: 20 }];

    const result = await renderLlmRubricPrompt(template, { items });

    expect(result).not.toContain('[object Object]');
    expect(result).toContain(JSON.stringify(items[0]));
    expect(result).toContain('string item');
    expect(result).toContain(JSON.stringify(items[2]));
  });

  it('should stringify deeply nested objects and arrays', async () => {
    const template = 'Complex data: {{data}}';
    const data = {
      products: [
        {
          name: 'Item 1',
          price: 10,
          details: {
            color: 'red',
            specs: { weight: '2kg', dimensions: { width: 10, height: 20 } },
          },
        },
        'string item',
        {
          name: 'Item 2',
          price: 20,
          nested: [{ a: 1 }, { b: 2 }],
          metadata: { tags: ['electronics', 'gadget'] },
        },
      ],
    };

    const result = await renderLlmRubricPrompt(template, { data });

    expect(result).not.toContain('[object Object]');
    expect(result).toContain('"specs":{"weight":"2kg"');
    expect(result).toContain('"dimensions":{"width":10,"height":20}');
    expect(result).toContain('[{"a":1},{"b":2}]');
    expect(result).toContain('"tags":["electronics","gadget"]');
    expect(result).toContain('string item');
  });
});

describe('matchesGEval', () => {
  let originalCallApi: typeof DefaultGradingProvider.callApi;

  beforeEach(() => {
    originalCallApi = DefaultGradingProvider.callApi;

    jest.spyOn(DefaultGradingProvider, 'callApi').mockImplementation(async (prompt) => {
      if (prompt.includes('generate 3-4 concise evaluation steps')) {
        return {
          output: '{"steps": ["Check clarity", "Evaluate coherence", "Assess grammar"]}',
          tokenUsage: { total: 10, prompt: 5, completion: 5 },
        };
      } else {
        return {
          output: '{"score": 8, "reason": "The response is well-structured and clear"}',
          tokenUsage: { total: 15, prompt: 8, completion: 7 },
        };
      }
    });
  });

  afterEach(() => {
    DefaultGradingProvider.callApi = originalCallApi;
  });

  it('should properly evaluate with default prompts', async () => {
    const criteria = 'Evaluate coherence and clarity';
    const input = 'Test input';
    const output = 'Test output';
    const threshold = 0.7;

    const result = await matchesGEval(criteria, input, output, threshold);

    expect(result).toEqual({
      pass: true,
      score: 0.8,
      reason: 'The response is well-structured and clear',
      tokensUsed: expect.any(Object),
    });

    expect(DefaultGradingProvider.callApi).toHaveBeenCalledTimes(2);
  });

  it('should handle custom rubric prompts', async () => {
    jest.resetAllMocks();

    const mockCallApi = jest
      .fn()
      .mockImplementationOnce(() => ({
        output: '{"steps": ["Custom step 1", "Custom step 2"]}',
        tokenUsage: { total: 10, prompt: 5, completion: 5 },
      }))
      .mockImplementationOnce(() => ({
        output: '{"score": 8, "reason": "Custom evaluation complete", "pass": true}',
        tokenUsage: { total: 15, prompt: 8, completion: 7 },
      }));

    DefaultGradingProvider.callApi = mockCallApi;

    const criteria = 'Evaluate coherence and clarity';
    const input = 'Test input';
    const output = 'Test output';
    const threshold = 0.7;

    const grading = {
      rubricPrompt: {
        steps: 'Custom steps template with {{criteria}}',
        evaluate: 'Custom evaluation template with {{criteria}} and {{steps}}',
      },
    } as any;

    const result = await matchesGEval(criteria, input, output, threshold, grading);

    expect(result.score).toBe(0.8);

    expect(mockCallApi).toHaveBeenCalledTimes(2);
    expect(mockCallApi).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('Custom steps template with'),
    );
    expect(mockCallApi).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('Custom evaluation template with'),
    );

    DefaultGradingProvider.callApi = originalCallApi;
  });

  it('should fail when score is below threshold', async () => {
    jest
      .spyOn(DefaultGradingProvider, 'callApi')
      .mockImplementationOnce(async () => {
        return {
          output: '{"steps": ["Check clarity", "Evaluate coherence", "Assess grammar"]}',
          tokenUsage: { total: 10, prompt: 5, completion: 5 },
        };
      })
      .mockImplementationOnce(async () => {
        return {
          output: '{"score": 3, "reason": "The response lacks coherence"}',
          tokenUsage: { total: 15, prompt: 8, completion: 7 },
        };
      });

    const criteria = 'Evaluate coherence and clarity';
    const input = 'Test input';
    const output = 'Test output';
    const threshold = 0.7;

    const result = await matchesGEval(criteria, input, output, threshold);

    expect(result).toEqual({
      pass: false,
      score: 0.3,
      reason: 'The response lacks coherence',
      tokensUsed: expect.any(Object),
    });
  });

  it('tracks token usage for both API calls', async () => {
    const criteria = 'Evaluate coherence and clarity';
    const input = 'Test input';
    const output = 'Test output';
    const threshold = 0.7;

    const result = await matchesGEval(criteria, input, output, threshold);

    expect(result.tokensUsed).toEqual({
      total: 25, // 10 from steps call + 15 from evaluation call
      prompt: 13, // 5 from steps call + 8 from evaluation call
      completion: 12, // 5 from steps call + 7 from evaluation call
      cached: 0,
      completionDetails: expect.any(Object),
    });
  });
});

describe('PROMPTFOO_DISABLE_OBJECT_STRINGIFY environment variable', () => {
  afterEach(() => {
    // Clean up environment variable after each test
    delete process.env.PROMPTFOO_DISABLE_OBJECT_STRINGIFY;
  });

  describe('Default behavior (PROMPTFOO_DISABLE_OBJECT_STRINGIFY=false)', () => {
    beforeEach(() => {
      process.env.PROMPTFOO_DISABLE_OBJECT_STRINGIFY = 'false';
    });

    it('should stringify objects to prevent [object Object] issues', async () => {
      const template = 'Product: {{product}}';
      const product = { name: 'Headphones', price: 99.99 };

      const result = await renderLlmRubricPrompt(template, { product });

      expect(result).not.toContain('[object Object]');
      expect(result).toBe(`Product: ${JSON.stringify(product)}`);
    });

    it('should stringify objects in arrays', async () => {
      const template = 'Items: {{items}}';
      const items = [{ name: 'Item 1', price: 10 }, 'string item', { name: 'Item 2', price: 20 }];

      const result = await renderLlmRubricPrompt(template, { items });

      expect(result).not.toContain('[object Object]');
      expect(result).toContain(JSON.stringify(items[0]));
      expect(result).toContain('string item');
      expect(result).toContain(JSON.stringify(items[2]));
    });
  });

  describe('Object access enabled (PROMPTFOO_DISABLE_OBJECT_STRINGIFY=true)', () => {
    beforeEach(() => {
      process.env.PROMPTFOO_DISABLE_OBJECT_STRINGIFY = 'true';
    });

    it('should allow direct object property access', async () => {
      const template = 'Product: {{product.name}} - ${{product.price}}';
      const product = { name: 'Headphones', price: 99.99 };

      const result = await renderLlmRubricPrompt(template, { product });

      expect(result).toBe('Product: Headphones - $99.99');
    });

    it('should allow array indexing and property access', async () => {
      const template = 'First item: {{items[0].name}}';
      const items = [
        { name: 'First Item', price: 10 },
        { name: 'Second Item', price: 20 },
      ];

      const result = await renderLlmRubricPrompt(template, { items });

      expect(result).toBe('First item: First Item');
    });
  });
});
