
/* Code execution service.
 * JavaScript runs locally in the browser. Python, Java, C and C++ use the
 * server-side /api/code proxy in production so provider credentials stay private.
 * For local development, VITE_JUDGE0_API_URL can point to a compatible endpoint.
 */

export const LANGUAGES = [
  { id: 'javascript', label: 'JavaScript', judge0: 63, runner: 'browser' },
  { id: 'python', label: 'Python 3', judge0: 71, runner: 'judge0' },
  { id: 'java', label: 'Java', judge0: 62, runner: 'judge0' },
  { id: 'cpp', label: 'C++', judge0: 54, runner: 'judge0' },
  { id: 'c', label: 'C', judge0: 50, runner: 'judge0' },
];

const isProduction = Boolean(import.meta.env.PROD);
const localJudge0Url = (import.meta.env.VITE_JUDGE0_API_URL || '').replace(/\/$/, '');
const executionBaseUrl = () => isProduction ? '/api/code' : localJudge0Url;

export const judge0Configured = () => Boolean(isProduction || localJudge0Url);

const b64 = (s) => btoa(unescape(encodeURIComponent(s ?? '')));
const unb64 = (s) => {
  try { return decodeURIComponent(escape(atob(s ?? ''))); }
  catch { return s ?? ''; }
};

/* ---- Browser runtime for JavaScript ---- */
function runJavaScript(problem, code) {
  const harness = `
    "use strict";
    const __logs = [];
    const console = { log: (...a) => __logs.push(a.map(String).join(' ')) };
    ${code}
    if (typeof ${problem.fnName} !== 'function')
      throw new Error('Function "${problem.fnName}" is not defined.');
    const __tests = ${JSON.stringify(problem.tests)};
    return __tests.map((t) => {
      const started = performance.now();
      try {
        const args = t.args.map((a) => JSON.parse(JSON.stringify(a)));
        const result = ${problem.fnName}(...args);
        return {
          ok: JSON.stringify(result) === JSON.stringify(t.expected),
          got: result,
          expected: t.expected,
          ms: performance.now() - started
        };
      } catch (err) {
        return {
          ok: false,
          error: String(err && err.message || err),
          expected: t.expected,
          ms: performance.now() - started
        };
      }
    });
  `;

  const startedAll = performance.now();

  try {
    const fn = new Function(harness);
    const results = fn();

    return {
      results: results.map((r, i) => ({
        index: i,
        passed: r.ok,
        got: r.error ? `Error: ${r.error}` : JSON.stringify(r.got),
        expected: JSON.stringify(r.expected),
        ms: r.ms,
        args: problem.tests[i].args,
      })),
      language: 'javascript',
      runtime: `Browser runtime · ${Math.max(1, Math.round(performance.now() - startedAll))}ms total`,
    };
  } catch (e) {
    return {
      compileError: String(e && e.message || e),
      results: [],
      language: 'javascript',
      runtime: 'Browser runtime',
    };
  }
}

/* ---- Build language-specific test drivers ---- */
function buildDriverSource(problem, langId, userCode) {
  const testsJSON = JSON.stringify(problem.tests);

  if (langId === 'python') {
    return `${userCode}
import json as __json

def __run():
    tests = __json.loads('''${testsJSON}''')
    out = []
    for t in tests:
        try:
            args = t["args"]
            res = ${problem.fnName}(*args)
            out.append({"ok": res == t["expected"], "got": res})
        except Exception as e:
            out.append({"ok": False, "got": "Error: " + str(e)})
    print(__json.dumps(out))

__run()
`;
  }

  if (langId === 'java') {
    const calls = problem.tests.map((t) => {
      const args = t.args.map((a) => javaLiteral(problem, a)).join(', ');
      const expectedStr = javaExpectedString(t.expected);

      return [
        `      try {`,
        `        Object res = Solution.${problem.fnName}(${args});`,
        `        String got;`,
        `        if (res instanceof int[]) got = java.util.Arrays.toString((int[]) res);`,
        `        else if (res instanceof String[]) got = java.util.Arrays.toString((String[]) res);`,
        `        else if (res instanceof boolean[]) got = java.util.Arrays.toString((boolean[]) res);`,
        `        else got = String.valueOf(res);`,
        `        boolean ok = got.equals(${JSON.stringify(expectedStr)});`,
        `        out.append("{\\"ok\\":" + ok + ",\\"got\\":\\"" + got.replace("\\"", "'") + "\\"}");`,
        `      } catch (Exception e) { out.append("{\\"ok\\":false,\\"got\\":\\"Error: " + String.valueOf(e.getMessage()).replace("\\"", "'") + "\\"}"); }`,
      ].join('\n');
    }).join('\n      if (i++ < N - 1) out.append(",");\n');

    return `import java.util.*;
${userCode.replace(/public\\s+class\\s+Solution/, 'class Solution')}
public class Main {
  public static void main(String[] a) {
    StringBuilder out = new StringBuilder("[");
    int i = 0;
    final int N = ${problem.tests.length};
${calls}
    out.append("]");
    System.out.println(out.toString());
  }
}
`;
  }

  if (langId === 'cpp') return cppDriverSource(problem, userCode);
  if (langId === 'c') return cDriverSource(problem, userCode);

  return userCode;
}

function javaLiteral(problem, v) {
  if (Array.isArray(v)) {
    if (typeof v[0] === 'string' && v.every((x) => String(x).length === 1))
      return JSON.stringify(v.join(''));

    if (typeof v[0] === 'number')
      return `new int[]{${v.join(',')}}`;

    if (typeof v[0] === 'string')
      return `new String[]{${v.map((x) => JSON.stringify(x)).join(',')}}`;

    return 'new int[]{}';
  }

  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return String(v);

  return String(v);
}

function javaExpectedString(v) {
  if (Array.isArray(v)) {
    if (typeof v[0] === 'string' && v.every((x) => String(x).length === 1))
      return v.join('');

    return `[${v.map((x) => String(x)).join(', ')}]`;
  }

  return String(v);
}

/* C++ drivers for the current built-in problem IDs. */
function cppDriverSource(problem, userCode) {
  const lines = [
    '#include <bits/stdc++.h>',
    'using namespace std;',
    userCode,
    'static void printVec(const vector<int>& v){ cout<<"["; for(size_t i=0;i<v.size();i++){if(i)cout<<",";cout<<v[i];} cout<<"]"; }',
    'static void printStr(const string& s){ cout<<"\\""; for(char c:s){if(c==\'\\\\\'||c==\'\\"\')cout<<\'\\\\\'; if(c==\'\\n\'){cout<<"\\\\n";continue;} cout<<c;} cout<<"\\""; }',
    'int main(){ cout<<"["; bool first=true; auto sep=[&](){if(!first)cout<<",";first=false;};'
  ];

  for (const t of problem.tests) {
    const a = t.args;
    const exp = t.expected;

    if (problem.id === 'two-sum') {
      lines.push(`{ vector<int> nums={${a[0].join(',')}}; auto got=${problem.fnName}(nums,${a[1]}); vector<int> expected={${exp.join(',')}}; bool ok=got==expected; sep(); cout<<"{\\"ok\\":"<<(ok?"true":"false")<<",\\"got\\":"; printVec(got); cout<<"}"; }`);
    } else if (problem.id === 'max-subarray') {
      lines.push(`{ vector<int> nums={${a[0].join(',')}}; auto got=${problem.fnName}(nums); bool ok=got==${exp}; sep(); cout<<"{\\"ok\\":"<<(ok?"true":"false")<<",\\"got\\":"<<got<<"}"; }`);
    } else if (problem.id === 'valid-palindrome' || problem.id === 'valid-parentheses') {
      lines.push(`{ string input=${JSON.stringify(a[0])}; bool got=${problem.fnName}(input); bool ok=got==${exp}; sep(); cout<<"{\\"ok\\":"<<(ok?"true":"false")<<",\\"got\\":"<<(got?"true":"false")<<"}"; }`);
    } else if (problem.id === 'move-zeroes') {
      lines.push(`{ vector<int> nums={${a[0].join(',')}}; ${problem.fnName}(nums); vector<int> expected={${exp.join(',')}}; bool ok=nums==expected; sep(); cout<<"{\\"ok\\":"<<(ok?"true":"false")<<",\\"got\\":"; printVec(nums); cout<<"}"; }`);
    } else if (problem.id === 'reverse-string') {
      const input = JSON.stringify(a[0].join(''));
      const expected = JSON.stringify(exp.join(''));
      lines.push(`{ string input=${input}; ${problem.fnName}(input); string expected=${expected}; bool ok=input==expected; sep(); cout<<"{\\"ok\\":"<<(ok?"true":"false")<<",\\"got\\":"; printStr(input); cout<<"}"; }`);
    }
  }

  lines.push('cout<<"]"; return 0; }');
  return lines.join('\n');
}

/* C drivers for the current built-in problem IDs. */
function cDriverSource(problem, userCode) {
  const lines = [
    '#include <stdio.h>',
    '#include <stdlib.h>',
    '#include <string.h>',
    '#include <stdbool.h>',
    userCode,
    'static void printVec(const int *v,int n){printf("[");for(int i=0;i<n;i++){if(i)printf(",");printf("%d",v[i]);}printf("]");}',
    'int main(void){ printf("["); int first=1;'
  ];

  const sep = 'if(!first)printf(",");first=0;';

  for (const t of problem.tests) {
    const a = t.args;
    const exp = t.expected;

    if (problem.id === 'two-sum') {
      lines.push(`{ int nums[]={${a[0].join(',')}}; int n=${a[0].length}; int expected[]={${exp.join(',')}}; int *got=${problem.fnName}(nums,n,${a[1]}); int ok=got && got[0]==expected[0] && got[1]==expected[1]; ${sep} printf("{\\"ok\\":%s,\\"got\\":",ok?"true":"false"); if(got)printVec(got,2);else printf("null"); printf("}"); }`);
    } else if (problem.id === 'max-subarray') {
      lines.push(`{ int nums[]={${a[0].join(',')}}; int got=${problem.fnName}(nums,${a[0].length}); int ok=got==${exp}; ${sep} printf("{\\"ok\\":%s,\\"got\\":%d}",ok?"true":"false",got); }`);
    } else if (problem.id === 'valid-palindrome' || problem.id === 'valid-parentheses') {
      lines.push(`{ char input[]=${JSON.stringify(a[0])}; bool got=${problem.fnName}(input); int ok=got==${exp ? 1 : 0}; ${sep} printf("{\\"ok\\":%s,\\"got\\":%s}",ok?"true":"false",got?"true":"false"); }`);
    } else if (problem.id === 'move-zeroes') {
      lines.push(`{ int nums[]={${a[0].join(',')}}; int n=${a[0].length}; ${problem.fnName}(nums,n); int expected[]={${exp.join(',')}}; int ok=1; for(int j=0;j<n;j++)if(nums[j]!=expected[j])ok=0; ${sep} printf("{\\"ok\\":%s,\\"got\\":",ok?"true":"false"); printVec(nums,n); printf("}"); }`);
    } else if (problem.id === 'reverse-string') {
      const input = JSON.stringify(a[0].join(''));
      const expected = JSON.stringify(exp.join(''));
      lines.push(`{ char input[]=${input}; int n=(int)strlen(input); ${problem.fnName}(input,n); int ok=strcmp(input,${expected})==0; ${sep} printf("{\\"ok\\":%s,\\"got\\":\\"%s\\"}",ok?"true":"false",input); }`);
    }
  }

  lines.push('printf("]"); return 0; }');
  return lines.join('\n');
}

/* ---- Submit code through the configured execution endpoint ---- */
async function runJudge0(problem, langId, code) {
  const base = executionBaseUrl();

  if (!base) {
    throw new Error(
      'Code execution is not configured. Set ONLINECOMPILER_API_KEY on the server.'
    );
  }

  const headers = { 'Content-Type': 'application/json' };

  // The production backend adds the provider's private API key.
  // Local development may use a Judge0-compatible endpoint.
  if (!isProduction) {
    const key = import.meta.env.VITE_JUDGE0_API_KEY || '';

    if (key) {
      headers['X-RapidAPI-Key'] = key;
      headers['X-RapidAPI-Host'] = new URL(base).host;
    }
  }

  const source = buildDriverSource(problem, langId, code);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);

  let response;

  try {
    response = await fetch(
      `${base}/submissions?base64_encoded=true&wait=true`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: b64(source),
          language_id: LANGUAGES.find((l) => l.id === langId).judge0,
        }),
        signal: ctrl.signal,
      }
    );
  } catch (error) {
    clearTimeout(timer);

    throw new Error(
      error.name === 'AbortError'
        ? 'Execution timed out. Try again.'
        : 'Network error contacting the code execution service.'
    );
  }

  clearTimeout(timer);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Code execution request failed (${response.status}). ${text.slice(0, 140)}`
    );
  }

  const data = await response.json();
  const statusId = data?.status?.id;
  const statusDescription = data?.status?.description || 'Unknown';

  if (statusId === 6) {
    return {
      compileError: unb64(data.compile_output) || 'Compilation failed.',
      results: [],
      runtime: statusDescription,
    };
  }

  if (statusId && statusId >= 7 && statusId <= 12) {
    return {
      runtimeError: unb64(data.stderr) || statusDescription,
      results: [],
      runtime: statusDescription,
    };
  }

  if (statusId === 5) {
    return {
      runtimeError: 'Time Limit Exceeded',
      results: [],
      runtime: statusDescription,
    };
  }

  const stdout = unb64(data.stdout).trim();
  let results;

  try {
    const parsed = JSON.parse(stdout.split('\n').pop());

    results = parsed.map((result, index) => ({
      index,
      passed: Boolean(result.ok),
      got: typeof result.got === 'string'
        ? result.got
        : JSON.stringify(result.got),
      expected: JSON.stringify(problem.tests[index].expected),
      args: problem.tests[index].args,
      ms: null,
    }));
  } catch {
    return {
      runtimeError: `Unexpected output from program:\n${stdout || unb64(data.stderr) || '(no output)'}`,
      results: [],
      runtime: statusDescription,
    };
  }

  const time = data.time
    ? `${Math.round(parseFloat(data.time) * 1000)}ms`
    : '—';

  const memory = data.memory
    ? `${(data.memory / 1024).toFixed(1)}MB`
    : '—';

  return {
    results,
    runtime: `OnlineCompiler.io · ${time} · ${memory}`,
  };
}

/** Run code against the problem's test cases. */
export async function runCode(problem, langId, code) {
  const language = LANGUAGES.find((item) => item.id === langId);

  if (!language) {
    throw new Error(`Unsupported language: ${langId}`);
  }

  if (language.runner === 'browser') {
    return runJavaScript(problem, code);
  }

  if (!judge0Configured()) {
    throw new Error(
      `JUDGE0_NOT_CONFIGURED:${language.label} execution is not configured. Set ONLINECOMPILER_API_KEY in the server environment and redeploy. JavaScript runs in the browser.`
    );
  }

  return runJudge0(problem, langId, code);
}
