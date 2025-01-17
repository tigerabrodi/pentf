const fs = require('fs');
const {html2pdf} = require('./browser_utils');
const {timezoneOffsetString} = require('./utils');
const {resultCountString} = require('./results');

const output = require('./output');

/**
 * @param {import('./config').Config} config
 * @param {import('./internal').TestResult} result
 * @returns {number}
 */
function getTestOrder(config, result) {
    const expectNothing = config.expect_nothing;

    if (result.status === 'error' && (!result.expectedToFail || expectNothing)) {
        return 1; // error
    } else if (result.status === 'success' && (result.expectedToFail && !expectNothing)) {
        return 2; // expectedToFailButPassed
    } else if (result.status === 'error' && (result.expectedToFail && !expectNothing)) {
        return 3; // expectedToFail
    } else if (result.status ==='flaky') {
        return 4; // flaky
    } else if (result.status === 'skipped') {
        return 5; // skipped
    }

    return 99;
}

/**
 * @param {import('./config').Config} config
 * @param {import('./runner').RunnerResult} test_info
 * @returns {import('./internal').CraftedResults}
 */
function craftResults(config, test_info) {
    output.logVerbose(config, '[results] crafting results...');
    const {test_start, test_end, state, ...moreInfo} = test_info;

    /** @type {TestResult[]} */
    const tests = Array.from(state.resultByTaskGroup.values());

    // Order tests by severity
    tests.sort((testA, testB) => {
        const a = getTestOrder(config, testA);
        const b = getTestOrder(config, testB);

        if (a < b) {
            return -1;
        } else if (a > b) {
            return 1;
        }

        // Sort alphabetically by task name if order is the same
        if (testA.name < testB.name) {
            return -1;
        } else if (testA.name > testB.name) {
            return 1;
        }

        return 0;
    });

    return {
        start: test_start,
        duration: test_end - test_start,
        config,
        tests,
        ...moreInfo,
    };
}

/**
 * @param {import('./config').Config} config
 * @param {import('./internal').CraftedResults} results
 */
async function doRender(config, results) {
    output.logVerbose(config, `[results] Render results JSON: ${config.json}, Markdown: ${config.markdown}, HTML: ${config.html}, PDF: ${config.pdf}`);

    if (config.json) {
        output.logVerbose(config, `Rendering to JSON to ${config.json_file}...`);
        const json = JSON.stringify(results, undefined, 2) + '\n';
        await fs.promises.writeFile(config.json_file, json, {encoding: 'utf-8'});
    }

    if (config.markdown) {
        output.logVerbose(config, `Rendering to Markdown to ${config.markdown_file} ...`);
        const md = markdown(results);
        await fs.promises.writeFile(config.markdown_file, md, {encoding: 'utf-8'});
    }

    if (config.html) {
        output.logVerbose(config, `Rendering to HTML ${config.html_file}...`);
        const html_code = html(results);
        await fs.promises.writeFile(config.html_file, html_code, {encoding: 'utf-8'});
    }

    if (config.pdf) {
        output.logVerbose(config, `Rendering to PDF ${config.pdf_file}...`);
        await pdf(config, config.pdf_file, results);
    }
}

function format_duration(ms) {
    if (ms === undefined) {
        return '';
    }

    const rounded = (Math.round(10 * ms / 1000) / 10);
    if (rounded < 0.1) {
        return '<0.1s';
    }
    let rounded_str = '' + rounded;
    if (! rounded_str.includes('.')) {
        rounded_str += '\xa0\xa0\xa0';
    }

    return rounded_str + 's';
}

function format_timestamp(ts) {
    const _pad = num => ('' + num).padStart(2, '0');
    const date = new Date(ts);

    return (
        date.getFullYear()
        + '-' + _pad(date.getMonth() + 1)
        + '-' + _pad(date.getDate())
        + ' ' + _pad(date.getHours())
        + ':' + _pad(date.getMinutes())
        + ':' + _pad(date.getSeconds())
        + timezoneOffsetString(date.getTimezoneOffset())
    );
}

function linkify(str) {
    let res = '';
    let pos = 0;

    const rex = /https?:\/\/[-_.\w:]+\/(?:[-_\w/:?#&=%.;]*)/g;
    let m;
    while ((m = rex.exec(str))) {
        res += escape_html(str.substring(pos, m.index));
        res += `<a href="${escape_html(m[0])}">${escape_html(m[0])}</a>`;
        pos = m.index + m[0].length;
    }
    res += escape_html(str.substring(pos));

    return res;
}

function escape_html(str) {
    // From https://stackoverflow.com/a/6234804/35070
    return (str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;'));
}

function heading(results) {
    return results.config.report_heading || 'End-To-End Test Report';
}

/**
 * @param {CraftedResults} results
 */
function markdown(results) {
    const table = results.tests.map((test_result, idx) => {
        return (
            '|' +
            (idx + 1) + ' | ' +
            test_result.name + ' | ' +
            (test_result.description || '') + ' | ' +
            _calcDuration(test_result.taskResults) + ' | ' +
            _calcSummaryStatus(test_result.taskResults) + ' |'
        );
    }).join('\n');

    const report_header_md = (
        results.config.report_header_md ? '\n' + results.config.report_header_md + '\n' : '');

    return `# ${heading(results)}
${report_header_md}
### Options
Tested Environment: **${results.config.env}**
Concurrency: ${results.config.concurrency === 0 ? 'sequential' : results.config.concurrency}${results.cpuCount ? ' (' + results.cpuCount + ' CPUs)' : ''}
${((results.config.repeat || 1) > 1) ?
        'Each test repeated **' + escape_html(results.config.repeat + '') + '** times  \n' : ''
}Start: ${format_timestamp(results.start)}

### Results
Total number of tests: ${results.tests.length} (${resultCountString(results.config, results.tests, true)})
Total test duration: ${format_duration(results.duration)}

| #     | Test              | Description       | Duration | Result  |
|---    |-----------------  |-----------------  | -------- | ------  |
${table}

`;
}

/**
 * @param {Buffer} screenshot
 * @returns {string}
 */
function screenshots_html(screenshot) {
    const dataUri = 'data:image/png;base64,' + (screenshot.toString('base64'));
    return (
        `<img src="${dataUri}" ` +
        'style="display:inline-block; width:250px; margin:2px 10px 2px 0; border: 1px solid #888;"/>');
}

function _calcSingleStatusStr(status) {
    return ({
        'success': '✔️',
        'error': '✘',
    }[status] || status);
}

function _calcSummaryStatus(taskResults) {
    if (taskResults.every(tr => tr.status === taskResults[0].status)) {
        return _calcSingleStatusStr(taskResults.length ? taskResults[0].status : 'skipped');
    }

    // Flaky results, tabulate
    const counter = new Map();
    for (const tr of taskResults) {
        counter.set(tr.status, (counter.get(tr.status) || 0) + 1);
    }

    return (Array.from(counter.keys())
        .sort()
        .map(status => counter.get(status) + _calcSingleStatusStr(status))
        .join(' '));
}

function _calcDuration(taskResults) {
    if (taskResults.length === 1) {
        return format_duration(taskResults[0].duration);
    }

    const durations = taskResults.map(tr => tr.duration);
    const max = Math.max(... durations);
    const min = Math.min(... durations);
    return format_duration(min) + ' - ' + format_duration(max);
}

/**
 * @param {import('./internal').CraftedResults} results
 */
function html(results) {
    const table = results.tests.map((testResult, idx) => {
        const {skipped, taskResults} = testResult;

        const errored = taskResults.some(tr => tr.status === 'error');
        let statusStr = _calcSummaryStatus(taskResults);
        if (skipped && testResult.skipReason) {
            statusStr = 'skipped: ' + testResult.skipReason;
        }

        const rowspan = (
            1 +
            (testResult.description ? 1 : 0) +
            (testResult.expectedToFail ? 1 : 0) +
            (errored ? 1 : 0));

        let res = (
            `<tr class="${idx % 2 != 0 ? 'odd' : ''}">` +
            `<td class="test_number" rowspan="${rowspan}">` + (idx + 1) + '</td>' +
            '<td class="test_name">' + escape_html(testResult.name) + '</td>' +
            (skipped ? '' : '<td class="duration">' + escape_html(_calcDuration(taskResults)) + '</td>') +
            `<td class="result result-${testResult.status}"` +
            ` ${skipped ? 'colspan="2"' : ''} rowspan=${testResult.description ? 2 : 1}>` +
            '<div>' + statusStr + '</div></td>' +
            '</tr>'
        );

        if (testResult.description) {
            res += (
                `<tr class="${idx % 2 != 0 ? 'odd' : ''}">` +
                '<td class="description" colspan="2">' +
                escape_html(testResult.description) +
                '</td>' +
                '</tr>'
            );
        }

        if (testResult.expectedToFail) {
            res += (
                `<tr class="${idx % 2 != 0 ? 'odd' : ''}">` +
                '<td class="expectedToFail" colspan="3">' +
                ((typeof testResult.expectedToFail === 'string')
                    ? 'Expected to fail: ' + linkify(testResult.expectedToFail)
                    : 'Expected to fail.'
                ) +
                '</td>' +
                '</tr>'
            );
        }

        if (errored) {
            res += `<tr class="${idx % 2 != 0 ? 'odd' : ''}"><td colspan="3">`;

            let first = true;
            for (const tr of taskResults) {
                if (tr.status !== 'error') continue;

                if (first) first = false;

                if (tr.pageUrls.length) {
                    const pageUrls = tr.pageUrls
                        .map(url => `<a href="${escape_html(url)}">${escape_html(url)}</a>`)
                        .join(', ');
                    res += `<p class="open_pages">Open pages: <span class="open_pages_list">${pageUrls}</span></p>`;
                }

                res += (
                    '<div class="error_stack"' + (first ? '' : ' style="margin-top:2em; overflow-wrap: break-word;word-break: break-all;"') + '>' +
                    escape_html(tr.error_stack || 'INTERNAL ERROR: no error stack') +
                    '</div>'
                );
                if (tr.error_screenshots) {
                    res += tr.error_screenshots
                        .map(img => screenshots_html(img))
                        .join('\n');
                }

                /** @type {import('./browser_utils').A11yResult[]} */
                const violations = tr.accessibilityErrors;

                if (violations.length) {
                    res += '<h3>Accessibility Violations</h3>';
                    for (const v of violations) {
                        const elements = v.nodes.map(node => {
                            let out = '<li class="axe-element">';
                            out +=  '<p>HTML: <code>' + escape_html(node.html) + '</code><br />';

                            for (let i = 0; i < node.selectors.length; i++) {
                                out += 'Selector: ' + escape_html(node.selectors[i]);

                                if (node.screenshots[i] !== null) {
                                    out += '<span class="axe-img">' + screenshots_html(node.screenshots[i]);
                                    out += '</span>';
                                }

                                out += '</p>';
                            }

                            out += '</li>';

                            return out;
                        });

                        const labels = {
                            minor: 'Minor',
                            moderate: 'Moderate',
                            serious: 'serious',
                            critical: 'critical',
                        };

                        const impact = labels[v.impact] + ': ';

                        res += (
                            '<p class="axe-description">' +
                                impact + escape_html(v.description) +
                            '</p>' +
                            '<span class="axe-link">' + linkify(v.helpUrl) + '</span>' +
                            '<ul>' + elements + '</ul>'
                        );
                    }
                }
            }
            res += '</td></tr>';
        }

        res += (
            `<tr class="${idx % 2 != 0 ? 'odd' : ''}">` +
            '<td colspan="4" class="test_footer">' +
            '</td>' +
            '</tr>'
        );

        return res;
    }).join('\n');

    const report_header_html = results.config.report_header_html || '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escape_html(heading(results))}</title>
<style>
* {
    box-sizing: border-box;
}
html, body {
    margin-top: 0;
    font-size: 26px;
    font-family: sans-serif;
}
h1 {
    margin: 0 0 .1em 0;
    text-align: center;
}
h2 {
    margin: 0;
}
p {
    margin: .2em 0 .8em 0;
}
table {
    margin-top: 0.5em;
    border-collapse: collapse;
}
thead th {
    text-align: left;
}
tr.odd td, tr.odd th {
    background: #eee;
}
td.test_number {
    vertical-align: top;
    text-align: right;
    padding-right: .4em;
}
td.test_number,
td.test_name,
td.test_duration {
    padding-top: 3px;
}
td.test_footer {
    height: 7px;
}

.open_pages {
    margin-top: 0.5rem;
    font-size: 70%;
}
.open_pages_list {
    color: #0088ff;
}
.description {
    font-size: 80%;
    color: #333;
}
.duration {
    text-align: right;
}
.error_stack {
    white-space: pre-wrap;
    font-family: monospace;
    font-size: 70%;
    color: #aa0000;
}
.expectedToFail {
    font-size: 80%;
    color: #aa0000;
    padding-bottom: 4px;
}
.axe-description {
    color: #aa0000;
    font-size: 80%;
    margin: 0;
}
.axe-link {
    font-size: 70%;
}
.axe-element {
    font-family: monospace;
    color: #aa0000;
    font-size: 80%;
}
.axe-img {
    margin-top: 1rem;
    display: block;
}
.result {
    vertical-align: top;
    text-align: center;
}
.result-skipped {
    text-align: right;
    padding-right: 1ex;
    color: #555;
}
.result-success {
    color: #250;
}
.result-success div {
    margin-top: -3px;
}
.result-error {
    color: #ff0000;
}
.result-error div {
    margin-top: 1px;
}

@media print {
    html, body {
        font-size: 16px;
    }
}
@page {
    size: A4;
    margin: 0.5cm 0.5cm;
}
</style>
</head>
<body>
<h1>${escape_html(heading(results))}</h1>

${report_header_html}
<h2>Options</h2>
<p>Tested Environment: <strong>${results.config.env}</strong><br/>
Concurrency: ${results.config.concurrency === 0 ? 'sequential' : results.config.concurrency}${results.cpuCount ? ' (' + results.cpuCount + ' CPUs)' : ''}<br/>
${((results.config.repeat || 1) > 1) ? 'Each test repeated <strong>' + escape_html(results.config.repeat + '') + '</strong> times<br/>' : ''}
Start: ${format_timestamp(results.start)}<br/>
Version: ${results.testsVersion}, pentf ${results.pentfVersion}<br/>
</p>

<h2>Results</h2>
Total number of tests: ${results.tests.length} (${resultCountString(results.config, results.tests, true)})<br/>
Total test duration: ${escape_html(format_duration(results.duration))}<br/>

<table style="width: 100%">
<tbody>
${table}
</tbody>
</table>
</body>
</html>

`;

}

async function pdf(config, path, results) {
    return html2pdf(config, path, html(results));
}

module.exports = {
    craftResults,
    doRender,
    // test only
    _linkify: linkify,
    _html: html,
};
