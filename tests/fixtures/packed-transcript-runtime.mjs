// Parent test owns a hard subprocess deadline. All model transport/children are
// deterministic fakes; the host SDK and both packed extension roots are real.
import assert from 'node:assert/strict';
import { findPackageJSON } from 'node:module';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installFusionFakePi } from '../helpers/fusion-fake-pi.ts';

const [packedRoot, hostPackage, root] = process.argv.slice(2);
assert.ok(packedRoot && hostPackage && root);
const manifest = JSON.parse(await readFile(join(hostPackage, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@earendil-works/pi-coding-agent');
const sdk = await import(pathToFileURL(join(hostPackage, 'dist/index.js')).href);
// Pi AI exposes ESM-only export conditions; require.resolve would choose the
// wrong conditions. Resolve the host's actual dependency, then its public import.
const aiManifestPath = findPackageJSON(
  '@earendil-works/pi-ai',
  pathToFileURL(join(hostPackage, 'dist/index.js')),
);
assert.ok(aiManifestPath);
const aiManifest = JSON.parse(await readFile(aiManifestPath, 'utf8'));
assert.equal(aiManifest.name, '@earendil-works/pi-ai');
assert.equal(
  aiManifest.version.split('.').slice(0, 2).join('.'),
  manifest.version.split('.').slice(0, 2).join('.'),
);
const aiEntry = aiManifest.exports['.'].import;
assert.equal(typeof aiEntry, 'string');
assert.ok(aiEntry.startsWith('./'));
const ai = await import(pathToFileURL(resolve(dirname(aiManifestPath), aiEntry)).href);
const transcriptHost = typeof ai.getCurrentSystemPrompt === 'function';
if (/^0\.86\./u.test(manifest.version)) assert.equal(transcriptHost, true);

const cwd = join(root, 'project');
const agentDir = join(root, 'agent');
await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);
const accountPath = join(root, 'account.json');
await writeFile(
  accountPath,
  JSON.stringify({
    userID: 'd'.repeat(64),
    oauthAccount: { accountUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  }),
);
Object.assign(process.env, {
  PI_BG_FEATURES: 'process,delegate,fusion',
  PI_BG_DOCK_SHORTCUT: 'off',
  PI_CODING_AGENT_DIR: agentDir,
  PI_ANTHROPIC_ACCOUNT_CONFIG_PATH: accountPath,
  PI_BG_TRANSCRIPT_TEST_KEY: 'offline-fixture',
  PI_OFFLINE: '1',
  PI_SKIP_VERSION_CHECK: '1',
  PI_TELEMETRY: '0',
});

const tool = (name, description = name) => ({
  name,
  description,
  parameters: ai.Type.Object({ path: ai.Type.String() }),
});
const initial = {
  role: 'system',
  content: [{ type: 'text', text: 'BASE_PROMPT' }],
  sections: { rules: 'OLD_RULES', removed: 'REMOVED_SECTION' },
  toolsAdded: [tool('old'), tool('read', 'old read')],
  timestamp: 1,
};
const patch = {
  role: 'system',
  content: 'APPENDED_PROMPT',
  sections: { rules: 'CURRENT_RULES', removed: null },
  toolsRemoved: [{ name: 'old' }, { name: 'read' }],
  toolsAdded: [tool('read', 'current read'), tool('inspect')],
  timestamp: 2,
};
const user = { role: 'user', content: 'VISIBLE_USER', timestamp: 3 };
const messages = [initial, user, patch, { ...user, content: 'VISIBLE_FOLLOWUP', timestamp: 4 }];
const expectedPrompt = 'BASE_PROMPT\n\nAPPENDED_PROMPT\n\nCURRENT_RULES';
const expectedTools = [tool('read', 'current read'), tool('inspect')];
const context = transcriptHost
  ? { messages }
  : { systemPrompt: expectedPrompt, tools: expectedTools, messages: [user, messages[3]] };
if (transcriptHost) {
  assert.equal(ai.getCurrentSystemPrompt(messages), expectedPrompt);
  assert.deepEqual(ai.getCurrentTools(messages), expectedTools);
}

const originalFetch = globalThis.fetch;
const settingsManager = sdk.SettingsManager.inMemory({
  defaultProvider: 'transcript-fixture',
  defaultModel: 'fixture',
});
const loader = new sdk.DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  additionalExtensionPaths: [
    join(packedRoot, 'dist/extensions/background-tasks.js'),
  ],
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noContextFiles: true,
  noThemes: true,
});
// #35 follow-up: exercise the handler registered by the packed public root, not
// a direct import of a private chunk. OMP 18.3.0 passes systemPrompt:string[] and
// no systemPromptOptions (extensions/runner.ts:1806 at tag v18.3.0). This models
// that event contract only; it is not native OMP/Windows execution evidence.
async function checkPackedShellGuidance(loaded) {
  assert.deepEqual(loaded.errors, []);
  const background = loaded.extensions.find((extension) => extension.tools.has('bg_status'));
  assert.ok(background, 'background public tool registration must remain intact');
  const hooks = background.handlers.get('before_agent_start');
  assert.equal(hooks?.length, 1);
  const handler = hooks[0];
  let expectedBlock;
  for (const mode of ['print', 'tui']) {
    const noUiContext = {
      mode,
      get ui() {
        throw new Error('prompt guidance must not access UI');
      },
    };
    const prompt = Object.freeze(['HOST_BASE, literal comma\r\nΩ', '', 'PEER_SECTION\n']);
    const event = {
      type: 'before_agent_start',
      prompt: 'hello',
      images: undefined,
      systemPrompt: prompt,
    };
    const result = await handler(event, noUiContext);
    assert.ok(Array.isArray(result.systemPrompt));
    assert.deepEqual(result.systemPrompt.slice(0, -1), [...prompt]);
    const block = result.systemPrompt.at(-1);
    assert.match(block, /^<pi_background_shell_policy>\n/u);
    assert.match(block, /activation shell policy/u);
    assert.match(block, /<\/pi_background_shell_policy>$/u);
    expectedBlock ??= block;
    assert.equal(block, expectedBlock);
    const second = await handler({ ...event, systemPrompt: result.systemPrompt }, noUiContext);
    assert.deepEqual(second, result);
    assert.deepEqual(prompt, ['HOST_BASE, literal comma\r\nΩ', '', 'PEER_SECTION\n']);
    const peerAfter = [...result.systemPrompt, 'LATER_EXTENSION'];
    assert.deepEqual(
      (await handler({ ...event, systemPrompt: peerAfter }, noUiContext)).systemPrompt,
      peerAfter,
    );
  }
  const stringResult = await handler({ systemPrompt: 'LEGACY_BASE' }, {});
  assert.equal(stringResult.systemPrompt, `LEGACY_BASE\n\n${expectedBlock}`);
  const options = { sections: { peer: 'MODERN_PEER' }, forceSystemPrompt: 'FORCED_BASE' };
  assert.equal(
    await handler({ systemPrompt: 'RENDERED', systemPromptOptions: options }, {}),
    undefined,
  );
  assert.equal(options.sections.peer, 'MODERN_PEER');
  assert.equal(options.forceSystemPrompt, `FORCED_BASE\n\n${expectedBlock}`);
  assert.equal(
    `<pi_background_shell_policy>\n${options.sections.pi_background_shell_policy}\n</pi_background_shell_policy>`,
    expectedBlock,
  );
}
let session;
try {
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  await checkPackedShellGuidance(loader.getExtensions());
  const priorFeatures = process.env.PI_BG_FEATURES;
  let processLoader;
  try {
    process.env.PI_BG_FEATURES = 'process';
    processLoader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: sdk.SettingsManager.inMemory(),
      additionalExtensionPaths: [
        join(packedRoot, 'dist/extensions/background-tasks.js'),
      ],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      noThemes: true,
    });
    await processLoader.reload();
    await checkPackedShellGuidance(processLoader.getExtensions());
    assert.equal(
      processLoader
        .getExtensions()
        .extensions.some((extension) => extension.tools.has('bg_delegate')),
      false,
    );
  } finally {
    processLoader?.getExtensions().runtime.invalidate('process-only prompt fixture finished');
    process.env.PI_BG_FEATURES = priorFeatures;
  }
  console.log(
    'packed shell guidance PASS: full/process; legacy string + OMP array + Pi sections; no UI dependency',
  );
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
  });
  const registry = new sdk.ModelRegistry(modelRuntime);
  registry.registerProvider('transcript-fixture', {
    api: 'openai-responses',
    baseUrl: 'https://example.invalid',
    apiKey: 'PI_BG_TRANSCRIPT_TEST_KEY',
    models: [
      {
        id: 'fixture',
        name: 'fixture',
        input: ['text'],
        reasoning: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272000,
        maxTokens: 4096,
      },
    ],
  });
  const sessionManager = sdk.SessionManager.inMemory(cwd);
  for (const message of messages) sessionManager.appendMessage(message);
  const created = await sdk.createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    settingsManager,
    modelRuntime,
    sessionManager,
    noTools: 'builtin',
  });
  session = created.session;
  // Observe completion without starting parent inference. Wake-up semantics have
  // their own scripted-provider suite; this fixture owns transcript boundaries.
  const notifications = [];
  session.sendCustomMessage = async (message) => {
    notifications.push(message);
  };
  await session.setModel(registry.find('transcript-fixture', 'fixture'));
  await session.bindExtensions({
    mode: 'json',
    onError: (error) => assert.fail(JSON.stringify(error)),
  });

  // Exercise real public launch -> task -> verified result, not semantic failure.
  // Only child inference is faked; the parent's registry/projection/artifacts are real.
  const fake = await installFusionFakePi(join(root, 'fusion'), {
    mergedText: 'FUSION_TRANSCRIPT_OK',
  });
  const fakeRoot = join(root, 'fake-host');
  const driver = join(fakeRoot, 'dist/cli.cjs');
  await mkdir(dirname(driver), { recursive: true });
  await writeFile(
    join(fakeRoot, 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-coding-agent', bin: { pi: 'dist/cli.cjs' } }),
  );
  await writeFile(
    driver,
    `
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
if (!process.env.PI_BG_DELEGATE_SEED_PATH) { require(${JSON.stringify(fake.packageCliPath)}); }
else {
 const raw=fs.readFileSync(process.env.PI_BG_DELEGATE_SEED_PATH); const seed=JSON.parse(raw); fs.readFileSync(0);
 const hash=b=>crypto.createHash('sha256').update(b).digest('hex'); const answer=Buffer.from('DELEGATE_TRANSCRIPT_OK');
 const pkg={schema_version:'pi-background-tasks.delegate-result.v1',task_id:seed.task_id,launch_nonce:seed.launch_nonce,
 seed_sha256:hash(raw),directive_sha256:seed.directive.sha256,route:{provider:seed.route.provider,model:seed.route.model},
 route_attestations:[{provider:seed.route.provider,model:seed.route.model,stop_reason:'stop'}],stop_reason:'stop',turns:1,tool_calls:0,
 usage:{status:'unavailable',reason:'offline child fixture'},answer:{encoding:'utf-8',byte_length:answer.length,sha256:hash(answer),
 blocks:[{kind:'text',byte_length:answer.length,sha256:hash(answer),data_base64:answer.toString('base64')}]},spilled_artifacts:[]};
 const out=path.join(process.env.PI_BG_DELEGATE_ARTIFACT_DIR,'result.json'); fs.writeFileSync(out+'.tmp',JSON.stringify(pkg)+'\\n'); fs.renameSync(out+'.tmp',out);
}
`,
  );
  const bin = join(root, 'bin');
  await mkdir(bin);
  const shim = join(bin, 'pi');
  await writeFile(shim, `#!/usr/bin/env node\nrequire(${JSON.stringify(driver)});\n`);
  await chmod(shim, 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
  // Native Windows resolution uses the declared host bin instead of a .cmd shim.
  process.argv[1] = driver;
  const execute = (name, params, callId = `test-${name}`) => {
    const definition = session.getToolDefinition(name);
    assert.ok(definition, name);
    return definition.execute(
      callId,
      params,
      undefined,
      undefined,
      session.extensionRunner.createContext(),
    );
  };
  async function settled(id) {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const status = await execute('bg_status', { taskId: id });
      if (status.details.tasks[0].status !== 'running') {
        assert.equal(status.details.tasks[0].status, 'completed', JSON.stringify(status.details));
        return;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.fail('fake child did not settle');
  }
  async function exerciseProjection(messageCount, visible) {
    const promptBefore = session.extensionRunner.createContext().getSystemPrompt();
    assert.equal(typeof promptBefore, 'string');
    const active = {
      role: 'assistant',
      api: 'openai-responses',
      provider: 'transcript-fixture',
      model: 'fixture',
      content: [
        {
          type: 'toolCall',
          id: 'active-delegate',
          name: 'bg_delegate',
          arguments: { prompt: 'ACTIVE_SECRET' },
        },
        {
          type: 'toolCall',
          id: 'active-fusion',
          name: 'fusion_reason',
          arguments: { prompt: 'SIBLING_SECRET' },
        },
      ],
      stopReason: 'toolUse',
      timestamp: 5,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    sessionManager.appendMessage(active);
    const delegate = await execute(
      'bg_delegate',
      { name: 'Transcript delegate', prompt: 'Inspect', notifyOnCompletion: false },
      'active-delegate',
    );
    await settled(delegate.details.task.id);
    const seed = JSON.parse(
      await readFile(resolve(cwd, delegate.details.artifact_dir, 'seed.json'), 'utf8'),
    );
    assert.equal(seed.parent_system_prompt, promptBefore);
    assert.equal(seed.conversation_projection.accounting.message_count, messageCount);
    assert.match(JSON.stringify(seed.conversation_projection), visible);
    assert.doesNotMatch(
      JSON.stringify(seed.conversation_projection),
      /BASE_PROMPT|OLD_RULES|CURRENT_RULES|ACTIVE_SECRET|SIBLING_SECRET/u,
    );
    const delegateResult = await execute('bg_result', { taskId: delegate.details.task.id });
    assert.equal(delegateResult.details.state, 'committed');
    assert.match(JSON.stringify(delegateResult.content), /DELEGATE_TRANSCRIPT_OK/u);
    const fusion = await execute(
      'fusion_reason',
      { prompt: 'Reason about the visible history' },
      'active-fusion',
    );
    await settled(fusion.details.task.id);
    const input = JSON.parse(
      await readFile(resolve(cwd, fusion.details.artifact_dir, 'canonical-input.json'), 'utf8'),
    );
    assert.equal(input.system_prompt, promptBefore);
    assert.equal(input.context.system_prompt, promptBefore);
    assert.equal(input.conversation_projection.accounting.message_count, messageCount);
    assert.match(JSON.stringify(input.conversation_projection), visible);
    assert.doesNotMatch(
      JSON.stringify(input.conversation_projection),
      /BASE_PROMPT|OLD_RULES|CURRENT_RULES|ACTIVE_SECRET|SIBLING_SECRET/u,
    );
    const fusionResult = await execute('bg_result', { taskId: fusion.details.task.id });
    assert.equal(fusionResult.details.state, 'committed');
    assert.match(JSON.stringify(fusionResult.content), /FUSION_TRANSCRIPT_OK/u);
  }
  await exerciseProjection(2, /VISIBLE_USER/u);
  const kept = sessionManager
    .getEntries()
    .find((entry) => entry.type === 'message' && entry.message.content === 'VISIBLE_FOLLOWUP');
  assert.ok(kept);
  sessionManager.branch(kept.id);
  sessionManager.appendCompaction('VISIBLE_SUMMARY', kept.id, 20_000);
  sessionManager.appendMessage({ ...user, content: 'AFTER_COMPACTION_USER' });
  session.agent.state.messages = sessionManager.buildSessionContext().messages;
  if (transcriptHost) assert.equal(session.agent.state.messages[0].role, 'system');
  await exerciseProjection(3, /VISIBLE_SUMMARY/u);
  sessionManager.appendMessage({
    role: 'future-role',
    content: 'must not disappear',
    timestamp: 6,
  });
  await assert.rejects(
    () => execute('bg_delegate', { name: 'Unknown role', prompt: 'Inspect' }),
    /unsupported conversation block: message role future-role/u,
  );
  await assert.rejects(
    () => execute('fusion_reason', { prompt: 'Reason' }),
    /unsupported conversation block: message role future-role/u,
  );
  assert.equal((await readFile(fake.logPath, 'utf8')).trim().split('\n').length, 10);
  console.log(
    `packed transcript runtime PASS: Pi ${manifest.version}; ${transcriptHost ? 'system replay' : 'legacy context'}; delegate + fusion verified results before/after real compaction`,
  );
} finally {
  globalThis.fetch = originalFetch;
  if (session) {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
  }
}
