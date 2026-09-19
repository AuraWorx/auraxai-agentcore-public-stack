/**
 * The Chromium MANAGED policy the browser is started with (spec D6).
 *
 * This is the feature's primary security control. A browser takeover hands a
 * human a fully interactive Chromium inside our AWS account, and the *only*
 * thing that stops them navigating to the LMS and having an agent act as them
 * is Chromium refusing — no check in our own code can, because it only ever
 * sees the page the takeover started on.
 *
 * So these tests care about two things: that the document says what we think
 * it says, and that the browser can actually read it.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { PlatformStack } from '../lib/platform-stack';
import { buildBrowserManagedPolicy } from '../lib/constructs/agentcore/browser-policy-construct';
import { createMockConfig, mockSsmContext, MOCK_ACCOUNT, MOCK_REGION } from './helpers/mock-config';

describe('buildBrowserManagedPolicy', () => {
  it('renders a Chromium URLBlocklist document', () => {
    expect(buildBrowserManagedPolicy(['a.example.com', 'b.example.com'])).toEqual({
      URLBlocklist: ['a.example.com', 'b.example.com'],
    });
  });

  it('is a blocklist, never an allowlist', () => {
    // An allowlist of assessment targets would need a new entry per VPAT
    // review, and the browser resource is immutable — that design was
    // rejected in D6 for exactly that reason.
    const policy = buildBrowserManagedPolicy(['x.example.com']);

    expect(policy).not.toHaveProperty('URLAllowlist');
  });

  it('copies the list rather than aliasing the config array', () => {
    const list = ['a.example.com'];
    const policy = buildBrowserManagedPolicy(list) as { URLBlocklist: string[] };
    list.push('mutated.example.com');

    expect(policy.URLBlocklist).toEqual(['a.example.com']);
  });

  it('renders an empty blocklist rather than omitting the key', () => {
    // An absent URLBlocklist and an empty one mean the same thing to Chromium,
    // but the explicit key makes "this environment blocks nothing" visible in
    // the deployed object instead of looking like a failed render.
    expect(buildBrowserManagedPolicy([])).toEqual({ URLBlocklist: [] });
  });
});

describe('browser policy in the stack', () => {
  let template: Template;

  beforeAll(() => {
    const config = createMockConfig();
    const app = new cdk.App();
    mockSsmContext(app, config);
    const stack = new PlatformStack(app, 'TestPlatformStack', {
      config,
      env: { account: MOCK_ACCOUNT, region: MOCK_REGION },
    });
    stack.wireCompute();
    template = Template.fromStack(stack);
  });

  it('versions the policy bucket so past states are auditable', () => {
    // This is a security control; what the browser was allowed to reach on a
    // given date is worth more than the storage.
    const buckets = Object.values(template.findResources('AWS::S3::Bucket'));
    const policyBucket = buckets.find((b) =>
      JSON.stringify((b.Properties as { BucketName?: unknown })?.BucketName ?? '').includes(
        'browser-policy',
      ),
    );

    expect(policyBucket).toBeDefined();
    expect((policyBucket!.Properties as { VersioningConfiguration?: { Status?: string } })
      .VersioningConfiguration?.Status).toBe('Enabled');
  });

  it('lets the browser execution role read the policy, and nothing else', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap(
      (p) =>
        ((p.Properties as { PolicyDocument?: { Statement?: { Sid?: string; Action?: string | string[] }[] } })
          ?.PolicyDocument?.Statement) ?? [],
    );
    const grant = statements.find((s) => s.Sid === 'BrowserEnterprisePolicyS3Access');

    expect(grant).toBeDefined();
    const actions = Array.isArray(grant!.Action) ? grant!.Action : [grant!.Action];
    expect(actions.sort()).toEqual(['s3:GetObject', 's3:GetObjectVersion']);
    // Read-only: the browser must never be able to rewrite its own policy.
    expect(actions.join(',')).not.toMatch(/PutObject|DeleteObject/);
  });

  it('passes the policy location to the runtime as a single S3 URI', () => {
    // Single variable on purpose — the runtime's 50-env-var ceiling is full.
    const runtimes = template.findResources('AWS::BedrockAgentCore::Runtime');
    const [runtime] = Object.values(runtimes);
    const env = (runtime.Properties as { EnvironmentVariables?: Record<string, unknown> })
      .EnvironmentVariables ?? {};

    expect(env).toHaveProperty('BROWSER_POLICY_S3');
    expect(env).not.toHaveProperty('BROWSER_POLICY_BUCKET');
  });
});
