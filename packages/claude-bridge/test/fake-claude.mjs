// CLI falso que imita o protocolo stream-json observado no Claude Code 2.1.314 (só para testes rápidos).
// Os formatos abaixo copiam os eventos reais registrados nas provas 1-3 de 30/10/2026.
import readline from 'node:readline';

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sid = 'fake-session-00000000-0000-0000-0000-000000000001';
let turn = 0;
let streaming = null;
let pendingTool = null;
let pendingQuestion = null;
let limitHit = false;
let steered = [];
// `--resume missing-*` imita o CLI 2.1.316 com sessão inexistente: result de erro "No conversation found with session ID" e saída 1.
const resumeAt = process.argv.indexOf('--resume');
const resumeId = resumeAt > 0 ? process.argv[resumeAt + 1] : null;
const lostSession = typeof resumeId === 'string' && resumeId.startsWith('missing-');

const init = () => out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake-model', permissionMode: 'default', cwd: process.cwd(), tools: ['Bash', 'AskUserQuestion'], mcp_servers: [], claude_code_version: '0.0.0-fake', skills: ['hq-fake-skill', 'sistema-web'], slash_commands: ['hq-fake-skill', 'sistema-web', 'compact'], plugins: [{ name: 'fake-plugin', version: '0.0.1' }], uuid: 'u-' + turn });
const result = (extra) => out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 5, duration_api_ms: 1, stop_reason: 'end_turn', terminal_reason: 'completed', result: '', errors: [], permission_denials: [], session_id: sid, uuid: 'r-' + turn, ...extra });

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'user') {
    // Mensagem no meio do turno (priority "next"): como no CLI 2.1.321, entra no próximo passo do MESMO turno; aqui o turno
    // "slow" termina citando o ajuste no resultado, sem abrir turno novo.
    if (m.priority && streaming) {
      const t = typeof m.message.content === 'string' ? m.message.content : m.message.content.map(b => b.text || '').join('');
      steered.push(t);
      return;
    }
    if (lostSession) {
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, duration_ms: 1, duration_api_ms: 0, stop_reason: null, terminal_reason: 'completed', result: '', errors: ['No conversation found with session ID: ' + resumeId], permission_denials: [], session_id: resumeId, uuid: 'r-missing' });
      setTimeout(() => process.exit(1), 10);
      return;
    }
    const text = typeof m.message.content === 'string' ? m.message.content : m.message.content.map(b => b.text || (b.type === 'image' ? '[image]' : '')).join('');
    turn++;
    init();
    out({ type: 'system', subtype: 'status', status: 'requesting', session_id: sid, uuid: 's-' + turn });
    // `HIT_LIMIT:<s> TURNS:<n>` imita o limite de 5 h do CLI 2.1.316 (formato copiado do banco real de 31/10/2026), só na 1ª vez
    // por processo: rate_limit_event "rejected" com resetsAt daqui a <s> segundos, assistente com error "rate_limit" e result api_error.
    // `OFFLINE` imita a falta de rede observada em 01/11/2026 (error "server_error", ENOTFOUND).
    const lim = /HIT_LIMIT:(\d+)/.exec(text);
    if (lim && !limitHit) {
      limitHit = true;
      const resetsAt = Math.floor(Date.now() / 1000) + Number(lim[1]);
      const turns = Number(/TURNS:(\d+)/.exec(text)?.[1] ?? 1);
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour', overageStatus: 'rejected', overageDisabledReason: 'out_of_credits', isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 1, resetsAt, status: 'rejected', surpassedThreshold: 1 } } }, session_id: sid, uuid: 'rl-' + turn });
      const msg = "You've hit your 5-hour limit · resets 12:40am (America/Sao_Paulo)";
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: msg }] }, error: 'rate_limit', parent_tool_use_id: null, session_id: sid, uuid: 'a-' + turn });
      result({ is_error: true, terminal_reason: 'api_error', stop_reason: 'stop_sequence', num_turns: turns, result: msg });
      return;
    }
    if (/OFFLINE/.test(text)) {
      const msg = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: msg }] }, error: 'server_error', parent_tool_use_id: null, session_id: sid, uuid: 'a-' + turn });
      result({ is_error: true, terminal_reason: 'api_error', stop_reason: 'stop_sequence', result: msg });
      return;
    }
    if (/bash/i.test(text)) {
      const id = 'toolu_fake_' + turn;
      pendingTool = { id, reqId: 'req-' + turn };
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'echo hi', description: 'Say hi' } }] }, parent_tool_use_id: null, session_id: sid, uuid: 'a-' + turn });
      out({ type: 'control_request', request_id: pendingTool.reqId, request: { subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input: { command: 'echo hi', description: 'Say hi' }, description: 'Say hi', permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'echo hi' }], behavior: 'allow', destination: 'localSettings' }], tool_use_id: id, decision_reason: 'This command requires approval' } });
    } else if (/question/i.test(text)) {
      const id = 'toolu_fake_q' + turn;
      const input = { questions: [{ question: 'Which color do you prefer?', header: 'Color', options: [{ label: 'red', description: 'Choose red' }, { label: 'blue', description: 'Choose blue' }], multiSelect: false }] };
      pendingQuestion = { id, reqId: 'req-' + turn };
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input }] }, parent_tool_use_id: null, session_id: sid, uuid: 'a-' + turn });
      out({ type: 'control_request', request_id: pendingQuestion.reqId, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input, tool_use_id: id, requires_user_interaction: true } });
    } else if (/slow/i.test(text)) {
      let n = 0;
      streaming = setInterval(() => {
        n++;
        out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'bla ' } }, parent_tool_use_id: null, session_id: sid, uuid: 'd-' + n });
        if (n >= 200) { clearInterval(streaming); streaming = null; result({ result: 'bla'.repeat(200) + (steered.length ? ' | ajuste: ' + steered.join(' / ') : ''), num_turns: steered.length ? 3 : 1 }); steered = []; }
      }, 50);
    } else if (text === 'ARGS') {
      const argv = process.argv.slice(2).join(' ');
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: argv }] }, parent_tool_use_id: null, session_id: sid, uuid: 'a-' + turn });
      result({ result: argv });
    } else if (/image/i.test(text)) {
      const hasImage = Array.isArray(m.message.content) && m.message.content.some(b => b.type === 'image');
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: hasImage ? 'Red.' : 'No image.' }] }, parent_tool_use_id: null, session_id: sid, uuid: 'a-' + turn });
      result({ result: hasImage ? 'Red.' : 'No image.' });
    } else {
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'echo: ' + text }] }, parent_tool_use_id: null, session_id: sid, uuid: 'a-' + turn });
      result({ result: 'echo: ' + text });
    }
  } else if (m.type === 'control_response') {
    const r = m.response.response;
    const reqId = m.response.request_id;
    if (pendingTool && reqId === pendingTool.reqId) {
      const { id } = pendingTool; pendingTool = null;
      if (r.behavior === 'allow') {
        out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'hi', is_error: false }] }, parent_tool_use_id: null, session_id: sid, uuid: 'u-' + turn });
        out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, parent_tool_use_id: null, session_id: sid, uuid: 'a2-' + turn });
        result({ num_turns: 2, result: 'ok' });
      } else {
        out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: r.message, is_error: true }] }, parent_tool_use_id: null, session_id: sid, uuid: 'u-' + turn });
        out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The command was denied.' }] }, parent_tool_use_id: null, session_id: sid, uuid: 'a2-' + turn });
        result({ num_turns: 2, result: 'The command was denied.', permission_denials: [{ tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'echo hi' } }] });
      }
    } else if (pendingQuestion && reqId === pendingQuestion.reqId) {
      const { id } = pendingQuestion; pendingQuestion = null;
      const answers = (r.updatedInput && r.updatedInput.answers) || {};
      const chosen = Object.values(answers)[0] || 'nothing';
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Your questions have been answered: "Which color do you prefer?"="${chosen}".` }] }, parent_tool_use_id: null, session_id: sid, uuid: 'u-' + turn });
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'you chose ' + chosen }] }, parent_tool_use_id: null, session_id: sid, uuid: 'a2-' + turn });
      result({ num_turns: 2, result: 'you chose ' + chosen });
    }
  } else if (m.type === 'control_request') {
    const sub = m.request.subtype;
    if (sub === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { still_queued: [] } } });
      if (streaming) {
        clearInterval(streaming); streaming = null;
        out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'bla bla' }] }, parent_tool_use_id: null, session_id: sid, uuid: 'a-int' });
        out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null, session_id: sid, uuid: 'u-int' });
        out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 2, duration_ms: 300, duration_api_ms: 1, stop_reason: null, terminal_reason: 'aborted_streaming', result: '', errors: ['[ede_diagnostic] result_type=user'], permission_denials: [], session_id: sid, uuid: 'r-int' });
      }
    } else if (sub === 'set_model' || sub === 'set_permission_mode') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    } else {
      out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'unsupported: ' + sub } });
    }
  }
});
rl.on('close', () => { if (streaming) clearInterval(streaming); process.exit(0); });
