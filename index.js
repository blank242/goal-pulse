import { extension_settings, saveMetadataDebounced } from '../../../extensions.js';
import {
    chat,
    chat_metadata,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    name1,
    name2,
    saveChatConditional,
    saveSettingsDebounced,
    setExtensionPrompt,
    updateMessageBlock,
} from '../../../../script.js';

const MODULE_NAME = 'goalPulse';
const DISPLAY_NAME = 'Goal Pulse';
const PROMPT_KEY = 'goal-pulse-score-update';
const GOAL_OPEN_TAG_RE = /<goal_score_update\b[^>]*>/gi;
const GOAL_CLOSE_TAG_RE = /<\/goal_score_update>/gi;
const MAX_CHARACTERS = 5;

const DEFAULT_SETTINGS = Object.freeze({
    globalPromptAppend: '',
});

const DEFAULT_CHAT_STATE = Object.freeze({
    enabled: false,
    scoreName: '점수',
    scoreDescription: '채팅 흐름에 따라 캐릭터별로 추적할 점수',
    unit: '점',
    maxScore: 100,
    defaultDeltaMin: -5,
    defaultDeltaMax: 5,
    bigDeltaUnit: 10,
    sensitivity: 1,
    trend: 'increase_preferred',
    includeCurrentScoresInPrompt: true,
    showDelta: true,
    promptAppend: '',
    characters: {},
});

let panelCollapsed = true;
let settingsModal = null;
let recalcQueued = false;
let panelAttachTimer = null;
let panelResizeObserver = null;
let activeHelpButton = null;

function clone(value) {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function esc(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
}

function toFiniteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function toBoolean(value, fallback = false) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLocaleLowerCase();
        if (['false', '0', 'no', 'off'].includes(normalized)) {
            return false;
        }
        if (['true', '1', 'yes', 'on'].includes(normalized)) {
            return true;
        }
    }
    return value === undefined ? fallback : Boolean(value);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function formatNumber(value) {
    return new Intl.NumberFormat().format(toFiniteNumber(value, 0));
}

function positionHelpTooltip(button, helpText) {
    const buttonRect = button.getBoundingClientRect();
    const modalRect = settingsModal?.querySelector('.goal-pulse-modal-dialog')?.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const margin = 8;
    const minLeft = Math.max(margin, modalRect?.left ?? margin);
    const maxRight = Math.min(viewportWidth - margin, modalRect?.right ?? viewportWidth - margin);
    const tooltipWidth = Math.min(280, maxRight - minLeft);

    helpText.style.maxWidth = `${tooltipWidth}px`;
    helpText.style.left = '0px';
    helpText.style.top = '0px';
    helpText.classList.add('goal-pulse-help-visible');

    const tooltipRect = helpText.getBoundingClientRect();
    let left = buttonRect.left;
    left = Math.max(minLeft, Math.min(left, maxRight - tooltipRect.width));

    let top = buttonRect.bottom + margin;
    if (top + tooltipRect.height > viewportHeight - margin) {
        top = buttonRect.top - tooltipRect.height - margin;
    }
    top = Math.max(margin, top);

    helpText.style.left = `${left}px`;
    helpText.style.top = `${top}px`;
}

function hideActiveHelpTooltip() {
    if (!activeHelpButton || !settingsModal) {
        activeHelpButton = null;
        return;
    }

    const key = activeHelpButton.dataset.goalPulseHelp;
    const selector = `[data-goal-pulse-help-text="${CSS.escape(key)}"]`;
    const helpText = activeHelpButton.closest('label')?.querySelector(selector) ?? settingsModal.querySelector(selector);
    helpText?.classList.remove('goal-pulse-help-visible');
    activeHelpButton.setAttribute('aria-expanded', 'false');
    activeHelpButton = null;
}

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = clone(DEFAULT_SETTINGS);
    }

    const settings = extension_settings[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) {
            settings[key] = clone(value);
        }
    }

    settings.globalPromptAppend = String(settings.globalPromptAppend ?? '');
    return settings;
}

function getChatState() {
    if (!chat_metadata[MODULE_NAME]) {
        chat_metadata[MODULE_NAME] = clone(DEFAULT_CHAT_STATE);
    }

    const state = chat_metadata[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_CHAT_STATE)) {
        if (state[key] === undefined) {
            state[key] = clone(value);
        }
    }

    if (state.scoreDescription === DEFAULT_CHAT_STATE.scoreDescription && typeof state.goal === 'string' && state.goal.trim() && state.goal.trim() !== '채팅 목표') {
        state.scoreDescription = state.goal.trim();
    }
    delete state.goal;

    if (!state.characters || typeof state.characters !== 'object') {
        state.characters = {};
    }

    if (!Object.keys(state.characters).length) {
        state.characters.char_1 = {
            name: name2 || '캐릭터 1',
            description: '',
            baseScore: 0,
            score: 0,
        };
    }

    state.enabled = toBoolean(state.enabled, false);
    state.maxScore = Math.max(1, toFiniteNumber(state.maxScore, DEFAULT_CHAT_STATE.maxScore));
    state.defaultDeltaMin = toFiniteNumber(state.defaultDeltaMin, DEFAULT_CHAT_STATE.defaultDeltaMin);
    state.defaultDeltaMax = toFiniteNumber(state.defaultDeltaMax, DEFAULT_CHAT_STATE.defaultDeltaMax);
    if (state.defaultDeltaMin > state.defaultDeltaMax) {
        [state.defaultDeltaMin, state.defaultDeltaMax] = [state.defaultDeltaMax, state.defaultDeltaMin];
    }
    state.bigDeltaUnit = Math.max(1, toFiniteNumber(state.bigDeltaUnit, DEFAULT_CHAT_STATE.bigDeltaUnit));
    state.sensitivity = clamp(toFiniteNumber(state.sensitivity, DEFAULT_CHAT_STATE.sensitivity), 0, 5);
    state.showDelta = toBoolean(state.showDelta, true);
    state.includeCurrentScoresInPrompt = toBoolean(state.includeCurrentScoresInPrompt, true);
    state.scoreName = String(state.scoreName ?? DEFAULT_CHAT_STATE.scoreName).trim() || DEFAULT_CHAT_STATE.scoreName;
    state.scoreDescription = String(state.scoreDescription ?? DEFAULT_CHAT_STATE.scoreDescription).trim() || DEFAULT_CHAT_STATE.scoreDescription;
    state.unit = String(state.unit ?? DEFAULT_CHAT_STATE.unit).trim() || DEFAULT_CHAT_STATE.unit;
    state.promptAppend = String(state.promptAppend ?? '');

    for (const character of Object.values(state.characters)) {
        character.name = String(character.name ?? '').trim();
        character.description = String(character.description ?? '');
        character.baseScore = clamp(toFiniteNumber(character.baseScore, 0), 0, state.maxScore);
        character.score = clamp(toFiniteNumber(character.score, 0), 0, state.maxScore);
    }

    return state;
}

function getEffectiveBoolean(state, key) {
    return state[key] ?? DEFAULT_CHAT_STATE[key];
}

function getCharacterEntries(state = getChatState()) {
    return Object.entries(state.characters)
        .filter(([, character]) => character && String(character.name ?? '').trim())
        .sort(([left], [right]) => {
            const leftNumber = Number(left.replace('char_', ''));
            const rightNumber = Number(right.replace('char_', ''));
            return leftNumber - rightNumber;
        })
        .slice(0, MAX_CHARACTERS);
}

function normalizeCharacterKey(value) {
    return String(value ?? '')
        .trim()
        .replace(/^\{\{/, '')
        .replace(/\}\}$/, '')
        .replace(/^@+/, '')
        .toLocaleLowerCase();
}

function resolveCharacterId(update, state = getChatState()) {
    const candidates = [
        update?.id,
        update?.characterId,
        update?.characterName,
        update?.name,
        update?.character,
    ]
        .map(value => String(value ?? '').trim())
        .filter(Boolean);

    for (const candidate of candidates) {
        if (Object.hasOwn(state.characters, candidate)) {
            return candidate;
        }
    }

    const entries = getCharacterEntries(state);
    for (const candidate of candidates) {
        const normalized = normalizeCharacterKey(candidate);
        const matched = entries.find(([id, character]) => {
            const aliases = [
                id,
                character.name,
                ...(Array.isArray(character.aliases) ? character.aliases : []),
            ];

            if (id === 'char_1') {
                aliases.push(name2);
            }
            if (id === 'char_2') {
                aliases.push(name1, 'user', '{{user}}');
            }

            return aliases.some(alias => normalizeCharacterKey(alias) === normalized);
        });
        if (matched) {
            return matched[0];
        }
    }

    return '';
}

function findGoalSegments(text) {
    const source = String(text ?? '');
    const openings = [...source.matchAll(GOAL_OPEN_TAG_RE)];
    GOAL_OPEN_TAG_RE.lastIndex = 0;
    if (!openings.length) {
        return [];
    }

    return openings.map((opening, index) => {
        const start = opening.index;
        const contentStart = start + opening[0].length;
        const nextOpeningStart = openings[index + 1]?.index ?? source.length;
        GOAL_CLOSE_TAG_RE.lastIndex = contentStart;
        const closing = GOAL_CLOSE_TAG_RE.exec(source);
        const hasClosing = Boolean(closing && closing.index < nextOpeningStart);
        const contentEnd = hasClosing ? closing.index : nextOpeningStart;
        const end = hasClosing ? closing.index + closing[0].length : nextOpeningStart;
        return {
            start,
            end,
            raw: source.slice(contentStart, contentEnd).trim(),
            hasClosing,
        };
    });
}

function parseGoalJson(raw) {
    const withoutFence = String(raw ?? '')
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

    const candidates = [withoutFence];
    const firstBrace = withoutFence.indexOf('{');
    const lastBrace = withoutFence.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        candidates.push(withoutFence.slice(firstBrace, lastBrace + 1));
    }

    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate);
        } catch {
            // Try the next candidate.
        }
    }

    return null;
}

function extractGoalUpdate(text) {
    const source = String(text ?? '');
    const segments = findGoalSegments(source);
    if (!segments.length) {
        return null;
    }

    const cleanedText = removeGoalBlocks(source);
    for (let index = segments.length - 1; index >= 0; index -= 1) {
        const raw = segments[index].raw;
        const parsed = parseGoalJson(raw);
        if (parsed) {
            return {
                raw,
                parsed,
                cleanedText,
            };
        }
    }

    console.warn(`[${DISPLAY_NAME}] Goal update block found but no valid JSON could be parsed.`);
    return {
        raw: segments[segments.length - 1]?.raw ?? '',
        parsed: null,
        cleanedText,
    };
}

function removeGoalBlocks(text) {
    const source = String(text ?? '');
    const segments = findGoalSegments(source);
    if (!segments.length) {
        return source;
    }

    let cleaned = '';
    let cursor = 0;
    for (const segment of segments) {
        cleaned += source.slice(cursor, segment.start);
        cursor = segment.end;
    }
    cleaned += source.slice(cursor);
    return cleaned.trim();
}

function validateParsedUpdate(parsed, state = getChatState()) {
    if (!parsed || parsed.updates === undefined) {
        return null;
    }

    const updateList = Array.isArray(parsed.updates)
        ? parsed.updates
        : Object.entries(parsed.updates).map(([characterId, value]) => ({
            characterId,
            delta: typeof value === 'object' && value !== null ? value.delta : value,
            reason: typeof value === 'object' && value !== null ? value.reason : '',
        }));

    const updates = [];
    for (const update of updateList) {
        const characterId = resolveCharacterId(update, state);
        if (!characterId) {
            console.warn(`[${DISPLAY_NAME}] Ignored update with unknown characterId.`, update, getCharacterEntries(state).map(([id, character]) => ({ id, name: character.name })));
            continue;
        }

        const delta = Number(update?.delta);
        if (!Number.isFinite(delta)) {
            console.warn(`[${DISPLAY_NAME}] Ignored update with invalid delta.`, update);
            continue;
        }

        const reason = typeof update?.reason === 'string' ? update.reason : '';
        updates.push({
            characterId,
            delta: clamp(delta, state.defaultDeltaMin, state.defaultDeltaMax),
            reason,
        });
    }

    return { updates };
}

function parseAndCleanMessage(messageId) {
    const state = getChatState();
    if (!state.enabled) {
        return false;
    }

    const message = chat[messageId];
    if (!message || message.is_user || message.is_system || typeof message.mes !== 'string') {
        return false;
    }

    const extracted = extractGoalUpdate(message.mes);
    if (!extracted) {
        return false;
    }

    const parsed = validateParsedUpdate(extracted.parsed, state);
    console.groupCollapsed(`[${DISPLAY_NAME}] goal_score_update from message ${messageId}`);
    console.log('Raw block before removal:', extracted.raw);
    console.log('Parsed JSON:', extracted.parsed);
    console.log('Validated updates to apply:', parsed?.updates ?? []);
    console.log('Configured characters:', getCharacterEntries(state).map(([id, character]) => ({ id, name: character.name, score: character.score })));
    console.groupEnd();

    message.extra ??= {};
    if (parsed) {
        message.extra[MODULE_NAME] = {
            raw: extracted.raw,
            parsed,
            appliedAt: Date.now(),
        };
    } else {
        delete message.extra[MODULE_NAME];
    }
    message.mes = extracted.cleanedText;

    try {
        updateMessageBlock(messageId, message);
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] Could not rerender message ${messageId}.`, error);
    }

    saveChatConditional();
    return Boolean(parsed);
}

function recalculateScores({ save = true } = {}) {
    const state = getChatState();
    if (!state.enabled) {
        updatePrompt();
        removePanel();
        return;
    }

    const entries = getCharacterEntries(state);
    const nextScores = Object.fromEntries(entries.map(([id, character]) => [id, clamp(toFiniteNumber(character.baseScore, 0), 0, state.maxScore)]));
    const lastUpdates = {};

    let cleanedAnyMessage = false;
    for (let messageId = 0; messageId < chat.length; messageId += 1) {
        const message = chat[messageId];
        if (message?.mes && findGoalSegments(message.mes).length) {
            parseAndCleanMessage(messageId);
            cleanedAnyMessage = true;
        }

        const parsed = message?.extra?.[MODULE_NAME]?.parsed;
        const valid = validateParsedUpdate(parsed, state);
        if (!valid) {
            continue;
        }

        for (const update of valid.updates) {
            if (!Object.hasOwn(nextScores, update.characterId)) {
                continue;
            }

            nextScores[update.characterId] = clamp(nextScores[update.characterId] + update.delta, 0, state.maxScore);
            if (update.delta !== 0 || update.reason) {
                lastUpdates[update.characterId] = {
                    delta: update.delta,
                    reason: update.reason,
                };
            }
        }
    }

    for (const [id, score] of Object.entries(nextScores)) {
        state.characters[id].score = score;
        state.characters[id].lastDelta = lastUpdates[id]?.delta ?? 0;
        state.characters[id].lastReason = lastUpdates[id]?.reason ?? '';
    }

    if (save) {
        if (cleanedAnyMessage) {
            saveChatConditional();
        }
        saveMetadataDebounced();
    }

    updatePrompt();
    renderPanel();
}

function calculateDeltaTotals(state = getChatState()) {
    const entries = getCharacterEntries(state);
    const totals = Object.fromEntries(entries.map(([id]) => [id, 0]));

    for (const message of chat) {
        const parsed = message?.extra?.[MODULE_NAME]?.parsed;
        const valid = validateParsedUpdate(parsed, state);
        if (!valid) {
            continue;
        }

        for (const update of valid.updates) {
            if (Object.hasOwn(totals, update.characterId)) {
                totals[update.characterId] += update.delta;
            }
        }
    }

    return totals;
}

function queueRecalculate() {
    if (!getChatState().enabled) {
        return;
    }

    if (recalcQueued) {
        return;
    }

    recalcQueued = true;
    setTimeout(() => {
        recalcQueued = false;
        recalculateScores();
    }, 100);
}

function buildPrompt() {
    const settings = getSettings();
    const state = getChatState();
    const characters = getCharacterEntries(state);
    if (!state.enabled || !characters.length) {
        return '';
    }

    const characterLines = characters.map(([id, character]) => {
        const description = String(character.description ?? '').trim();
        return description ? `- ${id}: ${character.name} - ${description}` : `- ${id}: ${character.name}`;
    });
    const characterIds = characters.map(([id]) => id).join(', ');

    const lines = [
        '<goal-pulse>',
        '## Goal pulse instruction',
        '- After your normal response body, append exactly one <goal_score_update> block and close it with </goal_score_update>.',
        '- Inside the tag, output JSON only. Do not use Markdown code fences.',
        '- Never use a shorthand closing tag such as </>.',
        '- Only include changed characters. Use delta values only. Absolute scores are forbidden.',
        `- characterId must be one of these exact IDs: ${characterIds}. Do not replace IDs with character names.`,
        '- The Goal Pulse score is a cumulative per-character metric defined by Metric definition below.',
        '- For this response, estimate how much the defined metric changed for each character and output only that change as delta.',
        '- Do not estimate abstract goal completion. Evaluate only the metric defined in Metric definition.',
        '- Review every character listed under Target characters independently.',
        '- If multiple characters have metric changes, include every changed character in the updates array. Do not choose only one character.',
        '- Include any character whose metric changed in this response, regardless of whether they are a main character, side character, or user character.',
        '- The score change is determined by the delta value.',
        '- Delta lower bound and Delta upper bound define the allowed delta range for a single response.',
        '- Minimal important change is the smallest absolute delta that should be treated as practically meaningful. Smaller deltas are allowed for minor changes, but important changes should generally meet or exceed this threshold.',
        '- Higher Response sensitivity means smaller actions can produce larger deltas. Lower Response sensitivity means only clearer changes should produce deltas.',
        '- If a score is already at the upper bound, positive deltas must not raise it above the upper bound. Negative deltas still apply normally.',
        '- Follow the output template exactly.',
        '- If there is no score change, output {"updates": []}.',
        '',
        '## Goal pulse Template',
        '{"updates":[{"characterId":"char_1","delta":1,"reason":"short reason"},{"characterId":"char_2","delta":-1,"reason":"short reason"}]}',
        '',
        '## Goal pulse details',
        `- Metric name: ${state.scoreName}`,
        `- Metric definition: ${state.scoreDescription}`,
        `- Measurement unit: ${state.unit}`,
        `- Upper bound: ${state.maxScore}`,
        `- Delta lower bound: ${state.defaultDeltaMin}`,
        `- Delta upper bound: ${state.defaultDeltaMax}`,
        `- Minimal important change: ${state.bigDeltaUnit}`,
        `- Response sensitivity: ${state.sensitivity} (0=almost no score movement, 1=normal, 5=very reactive)`,
        '',
        '## Target characters:',
        ...characterLines,
    ];

    if (getEffectiveBoolean(state, 'includeCurrentScoresInPrompt')) {
        lines.push(
            '',
            '## Current scores:',
            ...characters.map(([id, character]) => `- ${id} ${character.name}: ${character.score}/${state.maxScore}`),
        );
    }

    const globalPromptAppend = String(settings.globalPromptAppend ?? '').trim();
    if (globalPromptAppend) {
        lines.push(
            '',
            '## Global additional instruction',
            globalPromptAppend,
        );
    }

    const chatPromptAppend = String(state.promptAppend ?? '').trim();
    if (chatPromptAppend) {
        lines.push(
            '',
            '## Chat additional instruction',
            chatPromptAppend,
        );
    }

    lines.push('</goal-pulse>');

    return lines.join('\n');
}

function updatePrompt() {
    setExtensionPrompt(
        PROMPT_KEY,
        buildPrompt(),
        extension_prompt_types.IN_PROMPT,
        0,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

function ensurePanel() {
    let panel = document.getElementById('goal-pulse-panel');
    if (panel) {
        attachPanelBelowHeader(panel);
        return panel;
    }

    panel = document.createElement('div');
    panel.id = 'goal-pulse-panel';
    attachPanelBelowHeader(panel);
    if (!panel.parentElement) {
        document.body.append(panel);
        setPanelFallbackMode(panel);
        startPanelAttachRetry(panel);
    }

    observePanelSize(panel);
    return panel;
}

function attachPanelBelowHeader(panel) {
    const topBar = document.getElementById('top-bar');
    const sheld = document.getElementById('sheld');
    if (topBar?.parentElement && sheld?.parentElement === topBar.parentElement) {
        if (panel.parentElement !== topBar.parentElement || panel.nextElementSibling !== sheld) {
            topBar.parentElement.insertBefore(panel, sheld);
        }
        panel.classList.add('goal-pulse-under-header');
        panel.classList.remove('goal-pulse-fixed-fallback');
        document.body.classList.add('goal-pulse-has-under-header');
        document.body.classList.remove('goal-pulse-has-fixed-fallback');
        updatePanelHeightVar(panel);
        return true;
    }

    setPanelFallbackMode(panel);
    return false;
}

function setPanelFallbackMode(panel) {
    panel.classList.add('goal-pulse-fixed-fallback');
    panel.classList.remove('goal-pulse-under-header');
    document.body.classList.add('goal-pulse-has-fixed-fallback');
    document.body.classList.remove('goal-pulse-has-under-header');
    updatePanelHeightVar(panel);
}

function updatePanelHeightVar(panel = document.getElementById('goal-pulse-panel')) {
    const height = panel ? Math.ceil(panel.getBoundingClientRect().height) : 0;
    document.documentElement.style.setProperty('--goal-pulse-panel-height', `${height}px`);
}

function observePanelSize(panel) {
    if (panelResizeObserver || typeof ResizeObserver !== 'function') {
        updatePanelHeightVar(panel);
        return;
    }

    panelResizeObserver = new ResizeObserver(() => updatePanelHeightVar(panel));
    panelResizeObserver.observe(panel);
}

function removePanel() {
    const panel = document.getElementById('goal-pulse-panel');
    panel?.remove();
    document.body.classList.remove('goal-pulse-has-under-header', 'goal-pulse-has-fixed-fallback');
    document.documentElement.style.removeProperty('--goal-pulse-panel-height');
    if (panelAttachTimer) {
        clearInterval(panelAttachTimer);
        panelAttachTimer = null;
    }
    if (panelResizeObserver) {
        panelResizeObserver.disconnect();
        panelResizeObserver = null;
    }
}

function startPanelAttachRetry(panel) {
    if (panelAttachTimer) {
        return;
    }

    let attempts = 0;
    panelAttachTimer = setInterval(() => {
        attempts += 1;
        const attached = attachPanelBelowHeader(panel);
        if (attached || attempts >= 20) {
            clearInterval(panelAttachTimer);
            panelAttachTimer = null;
        }
    }, 500);
}

function renderPanel() {
    const state = getChatState();
    if (!state.enabled) {
        removePanel();
        return;
    }

    const panel = ensurePanel();
    const characters = getCharacterEntries(state);
    panel.classList.toggle('goal-pulse-collapsed', panelCollapsed);
    panel.classList.toggle('goal-pulse-hide-delta', !state.showDelta);

    panel.innerHTML = `
        <div class="goal-pulse-header">
            <div class="goal-pulse-compact-list">
                ${characters.map(([, character]) => renderCompactScoreItem(character, state)).join('') || '<div class="goal-pulse-empty">대상 캐릭터를 설정하세요.</div>'}
            </div>
            <button class="goal-pulse-icon-button" id="goal-pulse-toggle" title="접기/펼치기" aria-label="접기/펼치기">
                <i class="fa-solid ${panelCollapsed ? 'fa-chevron-down' : 'fa-chevron-up'}"></i>
            </button>
        </div>
        <div class="goal-pulse-body">
            <div class="goal-pulse-body-toolbar">
                <div class="goal-pulse-body-title">${esc(state.scoreName || 'Goal Pulse')}</div>
                <button class="goal-pulse-icon-button" id="goal-pulse-settings" title="Goal Pulse 설정" aria-label="Goal Pulse 설정">
                    <i class="fa-solid fa-gear"></i>
                </button>
            </div>
            ${characters.map(([id, character]) => renderScoreRow(id, character, state)).join('') || '<div class="goal-pulse-empty">대상 캐릭터를 설정하세요.</div>'}
        </div>
    `;

    panel.querySelector('#goal-pulse-toggle')?.addEventListener('click', () => {
        panelCollapsed = !panelCollapsed;
        renderPanel();
    });
    panel.querySelector('#goal-pulse-settings')?.addEventListener('click', openSettingsModal);
    requestAnimationFrame(() => updatePanelHeightVar(panel));
}

function renderCompactScoreItem(character, state) {
    const score = clamp(toFiniteNumber(character.score, 0), 0, state.maxScore);
    const delta = toFiniteNumber(character.lastDelta, 0);
    const deltaClass = delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral';
    const deltaText = delta ? `${delta > 0 ? '+' : ''}${formatNumber(delta)}${state.unit}` : `0${state.unit}`;

    return `
        <div class="goal-pulse-compact-item">
            <div class="goal-pulse-compact-name">${esc(character.name)}</div>
            <div class="goal-pulse-compact-score">${formatNumber(score)}${esc(state.unit)}</div>
            ${state.showDelta ? `<div class="goal-pulse-compact-delta ${deltaClass}">${esc(deltaText)}</div>` : ''}
        </div>
    `;
}

function renderScoreRow(id, character, state) {
    const score = clamp(toFiniteNumber(character.score, 0), 0, state.maxScore);
    const percentage = Math.round((score / state.maxScore) * 100);
    const delta = toFiniteNumber(character.lastDelta, 0);
    const deltaText = delta ? `${delta > 0 ? '+' : ''}${formatNumber(delta)}` : '';
    const reason = String(character.lastReason ?? '').trim();

    return `
        <div class="goal-pulse-row" data-character-id="${esc(id)}">
            <div class="goal-pulse-row-top">
                <span class="goal-pulse-name">${esc(character.name)}</span>
                <span class="goal-pulse-score">${formatNumber(score)} / ${formatNumber(state.maxScore)}${esc(state.unit)}</span>
            </div>
            <div class="goal-pulse-bar" role="progressbar" aria-valuenow="${score}" aria-valuemin="0" aria-valuemax="${state.maxScore}">
                <div class="goal-pulse-bar-fill" style="width: ${percentage}%"></div>
            </div>
            ${state.showDelta && (deltaText || reason) ? `<div class="goal-pulse-last">${esc(deltaText)}${deltaText && reason ? ' · ' : ''}${esc(reason)}</div>` : ''}
        </div>
    `;
}

function openSettingsModal() {
    if (settingsModal) {
        settingsModal.remove();
        settingsModal = null;
    }

    const state = getChatState();
    const settings = getSettings();
    settingsModal = document.createElement('div');
    settingsModal.id = 'goal-pulse-modal';
    settingsModal.innerHTML = `
        <div class="goal-pulse-model-backdrop" data-goal-pulse-close></div>
        <div class="goal-pulse-modal-dialog" role="dialog" aria-modal="true" aria-label="Goal Pulse 설정">
            <div class="goal-pulse-modal-header">
                <div class="goal-pulse-modal-title">Goal Pulse 설정</div>
                <button class="goal-pulse-icon-button" data-goal-pulse-close title="닫기" aria-label="닫기"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="goal-pulse-modal-body">
                <div class="goal-pulse-grid">
                    <label class="goal-pulse-field-with-help">
                        <span class="goal-pulse-label-line">
                            <span>점수 이름</span>
                            <button class="goal-pulse-info-button" type="button" data-goal-pulse-help="score-name" aria-expanded="false" title="점수 이름 설명">i</button>
                        </span>
                        <input class="text_pole" id="gp-score-name" value="${esc(state.scoreName)}">
                        <span class="goal-pulse-help-text" data-goal-pulse-help-text="score-name">상단 점수표와 프롬프트에 표시될 이름입니다. 예: 시청자 투표수, 신뢰도, 오염도.</span>
                    </label>
                    <label class="goal-pulse-field-with-help">
                        <span class="goal-pulse-label-line">
                            <span>단위</span>
                            <button class="goal-pulse-info-button" type="button" data-goal-pulse-help="unit" aria-expanded="false" title="단위 설명">i</button>
                        </span>
                        <input class="text_pole" id="gp-unit" value="${esc(state.unit)}">
                        <span class="goal-pulse-help-text" data-goal-pulse-help-text="unit">점수 뒤에 붙는 단위입니다. 예: 표, 점, %, 골드.</span>
                    </label>
                    <label class="goal-pulse-score-description-field goal-pulse-field-with-help">
                        <span class="goal-pulse-label-line">
                            <span>점수 설명</span>
                            <button class="goal-pulse-info-button" type="button" data-goal-pulse-help="score-description" aria-expanded="false" title="점수 설명">i</button>
                        </span>
                        <textarea class="text_pole" id="gp-score-description" rows="3" placeholder="이 점수가 무엇을 수치화하는지 설명">${esc(state.scoreDescription)}</textarea>
                        <span class="goal-pulse-help-text" data-goal-pulse-help-text="score-description">AI가 계산해야 하는 점수가 무엇인지 설명합니다. 목표가 아니라 실제로 늘거나 줄어야 하는 수치를 적어주세요.</span>
                    </label>
                    <label class="goal-pulse-field-with-help">
                        <span class="goal-pulse-label-line">
                            <span>최대 점수</span>
                            <button class="goal-pulse-info-button" type="button" data-goal-pulse-help="max-score" aria-expanded="false" title="최대 점수 설명">i</button>
                        </span>
                        <input class="text_pole" id="gp-max-score" type="number" min="1" value="${esc(state.maxScore)}">
                        <span class="goal-pulse-help-text" data-goal-pulse-help-text="max-score">점수가 올라갈 수 있는 최대값입니다. 이 값을 넘는 증가는 적용되지 않습니다.</span>
                    </label>
                    <label class="goal-pulse-field-with-help">
                        <span class="goal-pulse-label-line">
                            <span>의미 있는 변화 기준</span>
                            <button class="goal-pulse-info-button" type="button" data-goal-pulse-help="important-change" aria-expanded="false" title="의미 있는 변화 기준 설명">i</button>
                        </span>
                        <input class="text_pole" id="gp-big-delta" type="number" min="1" value="${esc(state.bigDeltaUnit)}">
                        <span class="goal-pulse-help-text" data-goal-pulse-help-text="important-change">이 정도 이상 변하면 꽤 중요한 변화로 보라는 기준입니다. AI에게 판단 기준으로만 전달됩니다.</span>
                    </label>
                    <label class="goal-pulse-field-with-help">
                        <span class="goal-pulse-label-line">
                            <span>최소 변화량</span>
                            <button class="goal-pulse-info-button" type="button" data-goal-pulse-help="delta-min" aria-expanded="false" title="최소 변화량 설명">i</button>
                        </span>
                        <input class="text_pole" id="gp-delta-min" type="number" value="${esc(state.defaultDeltaMin)}">
                        <span class="goal-pulse-help-text" data-goal-pulse-help-text="delta-min">한 번의 답변에서 적용할 수 있는 가장 작은 변화량입니다. 보통 음수로 설정합니다.</span>
                    </label>
                    <label class="goal-pulse-field-with-help">
                        <span class="goal-pulse-label-line">
                            <span>최대 변화량</span>
                            <button class="goal-pulse-info-button" type="button" data-goal-pulse-help="delta-max" aria-expanded="false" title="최대 변화량 설명">i</button>
                        </span>
                        <input class="text_pole" id="gp-delta-max" type="number" value="${esc(state.defaultDeltaMax)}">
                        <span class="goal-pulse-help-text" data-goal-pulse-help-text="delta-max">한 번의 답변에서 적용할 수 있는 가장 큰 변화량입니다. AI가 더 큰 값을 보내도 이 값으로 제한됩니다.</span>
                    </label>
                    <label class="goal-pulse-field-with-help">
                        <span class="goal-pulse-label-line">
                            <span>변화 민감도</span>
                            <button class="goal-pulse-info-button" type="button" data-goal-pulse-help="sensitivity" aria-expanded="false" title="변화 민감도 설명">i</button>
                        </span>
                        <input class="text_pole" id="gp-sensitivity" type="number" min="0" max="5" step="0.1" value="${esc(state.sensitivity)}">
                        <span class="goal-pulse-help-text" data-goal-pulse-help-text="sensitivity">0~5 사이로 값 조정 가능. 0에 가까울수록 점수가 거의 변하지 않고 5에 가까울수록 점수가 크게 변합니다. 기본값은 1.</span>
                    </label>
                </div>
                <div class="goal-pulse-switches">
                    <label class="goal-pulse-switch-row">
                        <span class="goal-pulse-switch-copy">
                            <span class="goal-pulse-switch-title">현재 점수를 프롬프트에 포함</span>
                            <span class="goal-pulse-switch-description">프롬프트에 현재 점수를 포함해서 AI 답변 내용에 영향을 줌</span>
                        </span>
                        <input id="gp-include-scores" type="checkbox" ${getEffectiveBoolean(state, 'includeCurrentScoresInPrompt') ? 'checked' : ''}>
                        <span class="goal-pulse-switch-control" aria-hidden="true"></span>
                    </label>
                    <label class="goal-pulse-switch-row">
                        <span class="goal-pulse-switch-copy">
                            <span class="goal-pulse-switch-title">점수 증감 표시</span>
                            <span class="goal-pulse-switch-description">채팅 상단 점수표의 현재 점수 증감 내역</span>
                        </span>
                        <input id="gp-show-delta" type="checkbox" ${state.showDelta ? 'checked' : ''}>
                        <span class="goal-pulse-switch-control" aria-hidden="true"></span>
                    </label>
                </div>
                <label class="goal-pulse-field-with-help">
                    <span class="goal-pulse-label-line">
                        <span>채팅 추가 프롬프트</span>
                        <button class="goal-pulse-info-button" type="button" data-goal-pulse-help="chat-prompt-append" aria-expanded="false" title="채팅 추가 프롬프트 설명">i</button>
                    </span>
                    <textarea class="text_pole" id="gp-chat-prompt-append" rows="4" placeholder="예: - 득표수는 사건이 일어난 시점 기준이 아닌 그 내용이 대중에게 전해진 시점을 기준으로 변해야한다.
- 다른 사람을 배려하거나 서로 돕는 모습은 득표수를 증가시킨다.
- 지나치게 파트 욕심을 내는 모습은 득표수를 감소시킨다.">${esc(state.promptAppend)}</textarea>
                    <span class="goal-pulse-help-text" data-goal-pulse-help-text="chat-prompt-append">현재 채팅에서만 점수 계산 프롬프트 뒤에 추가할 내용입니다. 특수한 판정 기준이 있을 때 사용하세요.</span>
                </label>
                <div class="goal-pulse-section-title">대상 캐릭터</div>
                <div id="goal-pulse-character-editor">
                    ${renderCharacterEditorRows(state)}
                </div>
            </div>
            <div class="goal-pulse-modal-footer">
                <button class="goal-pulse-footer-button goal-pulse-footer-button-secondary" id="gp-recalculate">재계산</button>
                <button class="goal-pulse-footer-button goal-pulse-footer-button-primary" id="gp-save">저장</button>
            </div>
        </div>
    `;

    document.body.append(settingsModal);
    settingsModal.querySelectorAll('[data-goal-pulse-close]').forEach(element => {
        element.addEventListener('click', closeSettingsModal);
    });
    settingsModal.querySelectorAll('.goal-pulse-character-toggle').forEach(button => {
        button.addEventListener('click', () => {
            const row = button.closest('.goal-pulse-character-row');
            if (!row) {
                return;
            }
            const isExpanded = row.classList.toggle('goal-pulse-character-expanded');
            button.setAttribute('aria-expanded', String(isExpanded));
            button.querySelector('i')?.classList.toggle('fa-chevron-down', !isExpanded);
            button.querySelector('i')?.classList.toggle('fa-chevron-up', isExpanded);
        });
    });
    settingsModal.querySelectorAll('[data-goal-pulse-help]').forEach(button => {
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            const key = button.dataset.goalPulseHelp;
            const selector = `[data-goal-pulse-help-text="${CSS.escape(key)}"]`;
            const helpText = button.closest('label')?.querySelector(selector) ?? settingsModal.querySelector(selector);
            if (!helpText) {
                return;
            }

            if (activeHelpButton === button && helpText.classList.contains('goal-pulse-help-visible')) {
                hideActiveHelpTooltip();
                return;
            }

            hideActiveHelpTooltip();
            activeHelpButton = button;
            button.setAttribute('aria-expanded', 'true');
            positionHelpTooltip(button, helpText);
        });
    });
    settingsModal.querySelector('.goal-pulse-modal-body')?.addEventListener('scroll', hideActiveHelpTooltip, { passive: true });
    settingsModal.addEventListener('click', (event) => {
        if (!event.target.closest('[data-goal-pulse-help]')) {
            hideActiveHelpTooltip();
        }
    });
    window.addEventListener('resize', hideActiveHelpTooltip, { once: true });
    settingsModal.querySelector('#gp-save')?.addEventListener('click', () => saveSettingsModal(false));
    settingsModal.querySelector('#gp-recalculate')?.addEventListener('click', () => saveSettingsModal(true));
}

function closeSettingsModal() {
    activeHelpButton = null;
    settingsModal?.remove();
    settingsModal = null;
}

function renderCharacterEditorRows(state) {
    const rows = [];
    for (let index = 1; index <= MAX_CHARACTERS; index += 1) {
        const id = `char_${index}`;
        const character = state.characters[id] ?? { name: '', description: '', baseScore: 0, score: 0 };
        rows.push(`
            <div class="goal-pulse-character-row" data-character-id="${id}">
                <div class="goal-pulse-character-header">
                    <label class="goal-pulse-field-with-help">
                        <span class="goal-pulse-label-line">
                            <span>캐릭터 ${index}</span>
                            <button class="goal-pulse-info-button" type="button" data-goal-pulse-help="character-name" aria-expanded="false" title="이름 설명">i</button>
                            <button class="goal-pulse-icon-button goal-pulse-character-toggle" type="button" title="펼치기/접기" aria-label="펼치기/접기" aria-expanded="false">
                                <i class="fa-solid fa-chevron-down"></i>
                            </button>
                        </span>
                        <input class="text_pole gp-character-name" value="${esc(character.name)}" maxlength="80" placeholder="이름">
                        <span class="goal-pulse-help-text" data-goal-pulse-help-text="character-name">AI가 점수를 구분할 캐릭터 이름입니다. 채팅에 실제로 등장하는 이름을 쓰는 것이 좋습니다.</span>
                    </label>
                </div>
                <div class="goal-pulse-character-body">
                    <label class="goal-pulse-field-with-help">
                        <span class="goal-pulse-label-line">
                            <span>현재 점수</span>
                            <button class="goal-pulse-info-button" type="button" data-goal-pulse-help="character-score" aria-expanded="false" title="현재 점수 설명">i</button>
                        </span>
                        <input class="text_pole gp-character-score" type="number" min="0" value="${esc(character.score)}">
                        <span class="goal-pulse-help-text" data-goal-pulse-help-text="character-score">지금까지 누적된 점수입니다. 수동으로 고치면 이후 재계산의 기준이 됩니다.</span>
                    </label>
                    <label class="goal-pulse-character-description goal-pulse-field-with-help">
                        <span class="goal-pulse-label-line">
                            <span>설명/별칭 메모</span>
                            <button class="goal-pulse-info-button" type="button" data-goal-pulse-help="character-description" aria-expanded="false" title="설명/별칭 메모 설명">i</button>
                        </span>
                        <input class="text_pole gp-character-description-input" value="${esc(character.description)}" maxlength="180">
                        <span class="goal-pulse-help-text" data-goal-pulse-help-text="character-description">동명이인, 별명, 역할처럼 AI가 캐릭터를 헷갈리지 않도록 도와주는 메모입니다.</span>
                    </label>
                </div>
            </div>
        `);
    }
    return rows.join('');
}

function saveSettingsModal(shouldRecalculate) {
    if (!settingsModal) {
        return;
    }

    const state = getChatState();
    state.scoreName = settingsModal.querySelector('#gp-score-name')?.value.trim() || DEFAULT_CHAT_STATE.scoreName;
    state.scoreDescription = settingsModal.querySelector('#gp-score-description')?.value.trim() || DEFAULT_CHAT_STATE.scoreDescription;
    state.unit = settingsModal.querySelector('#gp-unit')?.value.trim() || DEFAULT_CHAT_STATE.unit;
    state.maxScore = Math.max(1, toFiniteNumber(settingsModal.querySelector('#gp-max-score')?.value, DEFAULT_CHAT_STATE.maxScore));
    state.bigDeltaUnit = Math.max(1, toFiniteNumber(settingsModal.querySelector('#gp-big-delta')?.value, DEFAULT_CHAT_STATE.bigDeltaUnit));
    state.defaultDeltaMin = toFiniteNumber(settingsModal.querySelector('#gp-delta-min')?.value, DEFAULT_CHAT_STATE.defaultDeltaMin);
    state.defaultDeltaMax = toFiniteNumber(settingsModal.querySelector('#gp-delta-max')?.value, DEFAULT_CHAT_STATE.defaultDeltaMax);
    state.sensitivity = clamp(toFiniteNumber(settingsModal.querySelector('#gp-sensitivity')?.value, DEFAULT_CHAT_STATE.sensitivity), 0, 5);
    if (state.defaultDeltaMin > state.defaultDeltaMax) {
        [state.defaultDeltaMin, state.defaultDeltaMax] = [state.defaultDeltaMax, state.defaultDeltaMin];
    }
    state.includeCurrentScoresInPrompt = Boolean(settingsModal.querySelector('#gp-include-scores')?.checked);
    state.showDelta = Boolean(settingsModal.querySelector('#gp-show-delta')?.checked);
    state.promptAppend = settingsModal.querySelector('#gp-chat-prompt-append')?.value ?? '';

    const characters = {};
    settingsModal.querySelectorAll('.goal-pulse-character-row').forEach((row) => {
        const id = row.dataset.characterId;
        const name = row.querySelector('.gp-character-name')?.value.trim() ?? '';
        if (!name) {
            return;
        }

        const desiredScore = clamp(toFiniteNumber(row.querySelector('.gp-character-score')?.value, 0), 0, state.maxScore);
        characters[id] = {
            name,
            description: row.querySelector('.gp-character-description-input')?.value.trim() ?? '',
            baseScore: 0,
            score: desiredScore,
        };
    });
    if (Object.keys(characters).length) {
        state.characters = characters;
    }

    const deltaTotals = calculateDeltaTotals(state);
    for (const [id, character] of Object.entries(state.characters)) {
        character.baseScore = clamp(character.score - (deltaTotals[id] ?? 0), 0, state.maxScore);
    }

    saveMetadataDebounced();
    if (shouldRecalculate) {
        recalculateScores();
    } else {
        updatePrompt();
        renderPanel();
    }
    closeSettingsModal();
}

function renderGlobalSettings() {
    if (document.getElementById('goal-pulse-global-settings')) {
        return;
    }

    const settings = getSettings();
    const container = document.createElement('div');
    container.id = 'goal-pulse-global-settings';
    container.className = 'goal-pulse-global-settings';
    container.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Goal Pulse</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label>전역 추가 프롬프트<textarea class="text_pole" id="gp-global-prompt-append" rows="5" placeholder="모든 Goal Pulse 활성 채팅의 기본 프롬프트 뒤에 추가할 내용">${esc(settings.globalPromptAppend)}</textarea></label>
            </div>
        </div>
    `;

    const target = document.getElementById('extensions_settings');
    if (target) {
        target.append(container);
    }

    container.querySelector('#gp-global-prompt-append')?.addEventListener('input', (event) => {
        settings.globalPromptAppend = event.target.value;
        saveSettingsDebounced();
        updatePrompt();
    });
}

function updateMenuButtonState() {
    const button = document.getElementById('goal-pulse-wand-button');
    if (!button) {
        return;
    }

    const state = getChatState();
    button.classList.toggle('goal-pulse-wand-active', state.enabled);
    button.title = state.enabled ? 'Disable Goal Pulse for this chat' : 'Enable Goal Pulse for this chat';
}

function addGoalPulseMenuButton() {
    if (document.getElementById('goal-pulse-wand-button')) {
        updateMenuButtonState();
        return;
    }

    const container = document.getElementById('extensionsMenu');
    if (!container) {
        setTimeout(addGoalPulseMenuButton, 500);
        return;
    }

    const button = document.createElement('div');
    button.id = 'goal-pulse-wand-button';
    button.classList.add('list-group-item', 'flex-container', 'flexGap5');
    button.innerHTML = `
        <div class="fa-solid fa-chart-line extensionsMenuExtensionButton"></div>
        <span class="goal-pulse-wand-label">Goal Pulse</span>
    `;
    button.addEventListener('click', () => {
        const state = getChatState();
        state.enabled = !state.enabled;
        saveMetadataDebounced();
        updateMenuButtonState();
        updatePrompt();
        if (state.enabled) {
            recalculateScores();
        } else {
            removePanel();
        }
    });

    container.appendChild(button);
    $('#extensionsMenuButton').css('display', 'flex');
    updateMenuButtonState();
}

function onMessageReceived(messageId) {
    if (!getChatState().enabled) {
        return;
    }
    parseAndCleanMessage(messageId);
    queueRecalculate();
}

function onMessageEdited(messageId) {
    if (!getChatState().enabled) {
        return;
    }
    parseAndCleanMessage(messageId);
    queueRecalculate();
}

function onMessageUpdated(messageId) {
    if (!getChatState().enabled) {
        return;
    }
    parseAndCleanMessage(messageId);
    queueRecalculate();
}

function init() {
    getSettings();
    getChatState();
    panelCollapsed = true;
    renderGlobalSettings();
    addGoalPulseMenuButton();
    updatePrompt();
    if (getChatState().enabled) {
        recalculateScores({ save: false });
    } else {
        removePanel();
    }

    eventSource.on(event_types.CHAT_CHANGED, () => {
        getChatState();
        panelCollapsed = true;
        updateMenuButtonState();
        updatePrompt();
        if (getChatState().enabled) {
            recalculateScores({ save: false });
        } else {
            removePanel();
        }
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageUpdated);
    eventSource.on(event_types.MESSAGE_SWIPED, queueRecalculate);
    eventSource.on(event_types.MESSAGE_DELETED, queueRecalculate);
    eventSource.on(event_types.MESSAGE_UPDATED, onMessageUpdated);

    console.log(`[${DISPLAY_NAME}] loaded.`);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
