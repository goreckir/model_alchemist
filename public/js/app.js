// Model Alchemist v2.1 — Frontend Application with Deploy & File Browser
(function () {
    'use strict';

    // State
    let comparisonResult = null;
    let activeGroup = null;
    let activeFilter = 'all';
    let selectedKeys = new Set();
    let devPath = localStorage.getItem('ma_devPath') || '';
    let prodPath = localStorage.getItem('ma_prodPath') || '';

    // DOM Elements
    const connectionPanel = document.getElementById('connection-panel');
    const resultsPanel = document.getElementById('results-panel');
    const devPathInput = document.getElementById('dev-path');
    const prodPathInput = document.getElementById('prod-path');
    const btnCompare = document.getElementById('btn-compare');
    const btnNewCompare = document.getElementById('btn-new-compare');
    const btnRefresh = document.getElementById('btn-refresh');
    const btnDeploy = document.getElementById('btn-deploy');
    const deployCount = document.getElementById('deploy-count');
    const errorMessage = document.getElementById('error-message');
    const loading = document.getElementById('loading');
    const groupList = document.getElementById('group-list');
    const diffContent = document.getElementById('diff-content');
    const totalDiffs = document.getElementById('total-diffs');
    const countAdded = document.getElementById('count-added');
    const countRemoved = document.getElementById('count-removed');
    const countModified = document.getElementById('count-modified');
    const devModelName = document.getElementById('dev-model-name');
    const prodModelName = document.getElementById('prod-model-name');

    // Modal elements
    const deployModal = document.getElementById('deploy-modal');
    const resultModal = document.getElementById('result-modal');
    const deploySummary = document.getElementById('deploy-summary');
    const deployPreview = document.getElementById('deploy-preview');
    const btnConfirmDeploy = document.getElementById('btn-confirm-deploy');
    const btnCancelDeploy = document.getElementById('btn-cancel-deploy');
    const optBackup = document.getElementById('opt-backup');

    // Event Listeners
    btnCompare.addEventListener('click', handleCompare);
    btnNewCompare.addEventListener('click', handleNewCompare);
    btnRefresh.addEventListener('click', handleRefresh);
    btnDeploy.addEventListener('click', handleDeployClick);
    btnConfirmDeploy.addEventListener('click', handleConfirmDeploy);
    btnCancelDeploy.addEventListener('click', () => deployModal.classList.add('hidden'));
    document.getElementById('modal-close').addEventListener('click', () => deployModal.classList.add('hidden'));
    document.getElementById('result-close').addEventListener('click', () => resultModal.classList.add('hidden'));
    document.getElementById('btn-result-ok').addEventListener('click', () => resultModal.classList.add('hidden'));
    document.getElementById('btn-select-all').addEventListener('click', selectAllVisible);
    document.getElementById('btn-deselect-all').addEventListener('click', deselectAll);
    document.getElementById('btn-expand-all').addEventListener('click', expandAll);
    document.getElementById('btn-collapse-all').addEventListener('click', collapseAll);

    // File browser event listeners
    document.getElementById('btn-browse-dev').addEventListener('click', () => pickFile('dev'));
    document.getElementById('btn-browse-prod').addEventListener('click', () => pickFile('prod'));
    document.getElementById('btn-swap').addEventListener('click', swapModels);

    // Manual path edit - resolve on blur/enter
    devPathInput.addEventListener('change', () => resolveManualPath('dev'));
    prodPathInput.addEventListener('change', () => resolveManualPath('prod'));

    // Restore saved selections from localStorage
    restoreSavedPaths();

    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeFilter = btn.dataset.filter;
            renderDiffs();
        });
    });

    // Close modals on backdrop click
    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
        backdrop.addEventListener('click', () => {
            deployModal.classList.add('hidden');
            resultModal.classList.add('hidden');
        });
    });

    async function handleCompare() {
        if (!devPath || !prodPath) {
            showError('Please select both DEV and PROD model files.');
            return;
        }

        hideError();
        showLoading();

        try {
            const response = await fetch('/api/compare', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ devPath, prodPath })
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || `HTTP ${response.status}`);
            }

            comparisonResult = await response.json();
            selectedKeys.clear();
            showResults();
        } catch (err) {
            showError(err.message);
        } finally {
            hideLoading();
        }
    }

    async function handleRefresh() {
        if (!devPath || !prodPath) return;

        btnRefresh.disabled = true;
        btnRefresh.textContent = '⏳ Refreshing...';

        try {
            const response = await fetch('/api/compare', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ devPath, prodPath })
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || `HTTP ${response.status}`);
            }

            comparisonResult = await response.json();
            selectedKeys.clear();
            showResults();
        } catch (err) {
            showError(err.message);
        } finally {
            btnRefresh.disabled = false;
            btnRefresh.textContent = '🔄 Refresh';
        }
    }

    function handleNewCompare() {
        comparisonResult = null;
        activeGroup = null;
        activeFilter = 'all';
        selectedKeys.clear();
        connectionPanel.classList.remove('hidden');
        resultsPanel.classList.add('hidden');
        btnNewCompare.classList.add('hidden');
        btnRefresh.classList.add('hidden');
        btnDeploy.classList.add('hidden');
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.filter-btn[data-filter="all"]').classList.add('active');
        updateDeployButton();
    }

    function showResults() {
        connectionPanel.classList.add('hidden');
        resultsPanel.classList.remove('hidden');
        btnNewCompare.classList.remove('hidden');
        btnRefresh.classList.remove('hidden');
        btnDeploy.classList.remove('hidden');

        devModelName.textContent = comparisonResult.devSource;
        prodModelName.textContent = comparisonResult.prodSource;

        const diffs = comparisonResult.diffs || [];
        const added = diffs.filter(d => d.type === 0).length;
        const removed = diffs.filter(d => d.type === 1).length;
        const modified = diffs.filter(d => d.type === 2).length;

        totalDiffs.textContent = `${diffs.length} differences`;
        countAdded.textContent = `${added} added`;
        countRemoved.textContent = `${removed} removed`;
        countModified.textContent = `${modified} modified`;

        renderGroups();
        renderDiffs();
        updateDeployButton();
    }

    function renderGroups() {
        groupList.innerHTML = '';

        const allItem = createGroupItem('All', comparisonResult.diffs.length, activeGroup === null);
        allItem.addEventListener('click', () => {
            activeGroup = null;
            document.querySelectorAll('.group-item').forEach(i => i.classList.remove('active'));
            allItem.classList.add('active');
            renderDiffs();
        });
        groupList.appendChild(allItem);

        const groups = {};
        (comparisonResult.diffs || []).forEach(d => {
            const g = d.changeGroup || 'Other';
            groups[g] = (groups[g] || 0) + 1;
        });

        Object.entries(groups)
            .sort((a, b) => b[1] - a[1])
            .forEach(([name, count]) => {
                const item = createGroupItem(name, count, activeGroup === name);
                item.addEventListener('click', () => {
                    activeGroup = name;
                    document.querySelectorAll('.group-item').forEach(i => i.classList.remove('active'));
                    item.classList.add('active');
                    renderDiffs();
                });
                groupList.appendChild(item);
            });
    }

    function createGroupItem(name, count, isActive) {
        const item = document.createElement('div');
        item.className = 'group-item' + (isActive ? ' active' : '');
        item.innerHTML = `
            <span class="group-name">${escapeHtml(name)}</span>
            <span class="group-count">${count}</span>
        `;
        return item;
    }

    function renderDiffs() {
        let diffs = comparisonResult.diffs || [];

        if (activeGroup !== null) {
            diffs = diffs.filter(d => d.changeGroup === activeGroup);
        }
        if (activeFilter !== 'all') {
            const typeMap = { 'Added': 0, 'Removed': 1, 'Modified': 2 };
            diffs = diffs.filter(d => d.type === typeMap[activeFilter]);
        }

        if (diffs.length === 0) {
            diffContent.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">✓</div>
                    <p>No differences found for the selected filter.</p>
                </div>
            `;
            return;
        }

        diffs.sort((a, b) => {
            const order = { 0: 0, 2: 1, 1: 2 };
            return (order[a.type] || 0) - (order[b.type] || 0);
        });

        diffContent.innerHTML = '';
        for (const diff of diffs) {
            diffContent.appendChild(createDiffElement(diff));
        }
    }

    function createDiffElement(diff) {
        const typeClass = diff.type === 0 ? 'added' : diff.type === 1 ? 'removed' : 'modified';
        const isSelected = selectedKeys.has(diff.identityKey);

        const container = document.createElement('div');
        container.className = `diff-object ${typeClass}${isSelected ? ' selected' : ''}`;
        container.dataset.key = diff.identityKey;

        let leftContent = '';
        let rightContent = '';

        if (diff.type === 0) {
            leftContent = `
                <span class="diff-symbol">+</span>
                <span class="diff-object-type">[${escapeHtml(diff.objectType)}]</span>
                <span class="diff-object-name">${escapeHtml(diff.displayName)}</span>
                <span class="expand-indicator">▼</span>
            `;
        } else if (diff.type === 1) {
            rightContent = `
                <span class="diff-symbol">−</span>
                <span class="diff-object-type">[${escapeHtml(diff.objectType)}]</span>
                <span class="diff-object-name">${escapeHtml(diff.displayName)}</span>
                <span class="expand-indicator">▼</span>
            `;
        } else {
            leftContent = `
                <span class="diff-symbol">~</span>
                <span class="diff-object-type">[${escapeHtml(diff.objectType)}]</span>
                <span class="diff-object-name">${escapeHtml(diff.displayName)}</span>
                <span class="expand-indicator">▼</span>
            `;
            rightContent = `
                <span class="diff-symbol">~</span>
                <span class="diff-object-type">[${escapeHtml(diff.objectType)}]</span>
                <span class="diff-object-name">${escapeHtml(diff.displayName)}</span>
            `;
        }

        container.innerHTML = `
            <div class="diff-object-header">
                <div class="diff-checkbox-cell">
                    <input type="checkbox" class="diff-checkbox" data-key="${escapeHtml(diff.identityKey)}" ${isSelected ? 'checked' : ''} />
                </div>
                <div class="diff-object-header-left">${leftContent}</div>
                <div class="diff-object-header-right">${rightContent}</div>
            </div>
            <div class="diff-properties"></div>
        `;

        // Checkbox handler
        const checkbox = container.querySelector('.diff-checkbox');
        checkbox.addEventListener('click', (e) => {
            e.stopPropagation();
            if (checkbox.checked) {
                selectedKeys.add(diff.identityKey);
                container.classList.add('selected');
            } else {
                selectedKeys.delete(diff.identityKey);
                container.classList.remove('selected');
            }
            updateDeployButton();
        });

        // Expand/collapse on header click (but not checkbox)
        const headerLeft = container.querySelector('.diff-object-header-left');
        const headerRight = container.querySelector('.diff-object-header-right');
        const propsContainer = container.querySelector('.diff-properties');

        const toggleExpand = () => {
            if (propsContainer.classList.contains('expanded')) {
                propsContainer.classList.remove('expanded');
            } else {
                propsContainer.classList.add('expanded');
                if (propsContainer.children.length === 0) {
                    renderProperties(diff, propsContainer);
                }
            }
        };

        headerLeft.addEventListener('click', toggleExpand);
        headerRight.addEventListener('click', toggleExpand);

        return container;
    }

    function renderProperties(diff, container) {
        const props = diff.propertyDiffs || [];
        if (props.length === 0) {
            container.innerHTML = `
                <div class="diff-prop-row">
                    <div class="diff-prop-spacer"></div>
                    <div class="diff-prop-left" style="color: var(--color-text-dim);">No property details</div>
                    <div class="diff-prop-right"></div>
                </div>
            `;
            return;
        }

        for (const prop of props) {
            if (!prop.devValue && !prop.prodValue) continue;

            const row = document.createElement('div');
            row.className = 'diff-prop-row';

            const devDisplay = prop.devValue != null ? formatValue(prop.devValue) : '';
            const prodDisplay = prop.prodValue != null ? formatValue(prop.prodValue) : '';

            let leftHtml = devDisplay
                ? `<span class="diff-prop-name">${escapeHtml(prop.propertyName)}:</span>${escapeHtml(devDisplay)}`
                : '';
            let rightHtml = prodDisplay
                ? `<span class="diff-prop-name">${escapeHtml(prop.propertyName)}:</span>${escapeHtml(prodDisplay)}`
                : '';

            row.innerHTML = `
                <div class="diff-prop-spacer"></div>
                <div class="diff-prop-left">${leftHtml}</div>
                <div class="diff-prop-right">${rightHtml}</div>
            `;
            container.appendChild(row);
        }
    }

    // ===== Deploy Flow =====

    function updateDeployButton() {
        const count = selectedKeys.size;
        deployCount.textContent = count;
        btnDeploy.disabled = count === 0;
    }

    function selectAllVisible() {
        document.querySelectorAll('.diff-checkbox').forEach(cb => {
            cb.checked = true;
            selectedKeys.add(cb.dataset.key);
            cb.closest('.diff-object').classList.add('selected');
        });
        updateDeployButton();
    }

    function deselectAll() {
        selectedKeys.clear();
        document.querySelectorAll('.diff-checkbox').forEach(cb => {
            cb.checked = false;
            cb.closest('.diff-object').classList.remove('selected');
        });
        updateDeployButton();
    }

    function expandAll() {
        document.querySelectorAll('.diff-properties').forEach(el => {
            if (!el.classList.contains('expanded')) {
                el.classList.add('expanded');
                if (el.children.length === 0) {
                    const diffObj = el.closest('.diff-object');
                    const key = diffObj.querySelector('.diff-checkbox')?.dataset.key;
                    if (key) {
                        const diff = comparisonResult.diffs.find(d => d.identityKey === key);
                        if (diff) renderProperties(diff, el);
                    }
                }
            }
        });
    }

    function collapseAll() {
        document.querySelectorAll('.diff-properties.expanded').forEach(el => {
            el.classList.remove('expanded');
        });
    }

    async function handleDeployClick() {
        if (selectedKeys.size === 0) return;

        // Show deploy modal with preview
        const selectedDiffs = comparisonResult.diffs.filter(d => selectedKeys.has(d.identityKey));
        const added = selectedDiffs.filter(d => d.type === 0).length;
        const removed = selectedDiffs.filter(d => d.type === 1).length;
        const modified = selectedDiffs.filter(d => d.type === 2).length;

        deploySummary.innerHTML = `
            <p>Deploying <span class="count-highlight">${selectedDiffs.length}</span> changes to PROD:</p>
            <p style="margin-left: 16px;">
                ${added ? `<span class="badge-count badge-added">${added} to add</span> ` : ''}
                ${removed ? `<span class="badge-count badge-removed">${removed} to remove</span> ` : ''}
                ${modified ? `<span class="badge-count badge-modified">${modified} to modify</span> ` : ''}
            </p>
            <p style="margin-top: 8px; font-size: 13px; color: var(--color-text-dim);">
                Target: <code>${escapeHtml(prodPathInput.value)}</code>
            </p>
        `;

        // Get preview
        try {
            const response = await fetch('/api/deploy/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ selectedKeys: [...selectedKeys] })
            });
            const preview = await response.json();

            if (preview.actions && preview.actions.length > 0) {
                deployPreview.innerHTML = preview.actions.map(a => {
                    const cls = a.action === 'add' ? 'action-add' : a.action === 'remove' ? 'action-remove' : 'action-modify';
                    const icon = a.action === 'add' ? '+' : a.action === 'remove' ? '−' : '~';
                    return `<div class="deploy-action ${cls}">
                        <span class="deploy-action-icon">${icon}</span>
                        <span class="deploy-action-text">[${escapeHtml(a.objectType)}] ${escapeHtml(a.name)} → ${escapeHtml(a.file || '')}</span>
                    </div>`;
                }).join('');
            } else {
                deployPreview.innerHTML = '<p style="color: var(--color-text-dim);">No file operations planned.</p>';
            }
        } catch {
            deployPreview.innerHTML = '<p style="color: var(--color-removed-text);">Failed to load preview.</p>';
        }

        deployModal.classList.remove('hidden');
    }

    async function handleConfirmDeploy() {
        deployModal.classList.add('hidden');

        try {
            const response = await fetch('/api/deploy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    selectedKeys: [...selectedKeys],
                    dryRun: false,
                    backup: optBackup.checked
                })
            });

            const result = await response.json();
            showDeployResult(result);
        } catch (err) {
            showDeployResult({ success: false, errors: [{ error: err.message }], actions: [] });
        }
    }

    function showDeployResult(result) {
        const titleEl = document.getElementById('result-title');
        const bodyEl = document.getElementById('result-body');

        if (result.success) {
            titleEl.textContent = '✓ Deployment Successful';
            titleEl.className = 'result-success';
        } else {
            titleEl.textContent = '✗ Deployment Had Errors';
            titleEl.className = 'result-error';
        }

        let html = '';
        if (result.backupPath) {
            html += `<p style="margin-bottom: 12px; font-size: 13px;">Backup: <code>${escapeHtml(result.backupPath)}</code></p>`;
        }

        if (result.actions && result.actions.length > 0) {
            html += `<p style="font-weight: 600; margin-bottom: 8px;">${result.actions.length} operations executed:</p>`;
            html += '<div class="result-actions">';
            for (const action of result.actions) {
                html += `<div class="result-action-item">✓ ${escapeHtml(action.action || '')} [${escapeHtml(action.objectType || '')}] ${escapeHtml(action.name || '')}</div>`;
            }
            html += '</div>';
        }

        if (result.errors && result.errors.length > 0) {
            html += `<p style="font-weight: 600; margin-top: 16px; color: var(--color-removed-text);">Errors:</p>`;
            html += '<div class="result-actions">';
            for (const err of result.errors) {
                html += `<div class="result-action-item" style="border-left: 3px solid var(--color-removed-text);">✗ ${escapeHtml(err.error || JSON.stringify(err))}</div>`;
            }
            html += '</div>';
        }

        bodyEl.innerHTML = html;
        resultModal.classList.remove('hidden');
    }

    // ===== Utilities =====

    function formatValue(value) {
        if (value === null || value === undefined) return '';
        const str = String(value);
        return str.length > 1000 ? str.substring(0, 1000) + '\n... (truncated)' : str;
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function showError(msg) { errorMessage.textContent = msg; errorMessage.classList.remove('hidden'); }
    function hideError() { errorMessage.classList.add('hidden'); }
    function showLoading() { loading.classList.remove('hidden'); btnCompare.disabled = true; }
    function hideLoading() { loading.classList.add('hidden'); btnCompare.disabled = false; }

    // ===== Native File Picker =====

    async function resolveManualPath(target) {
        const input = target === 'dev' ? devPathInput : prodPathInput;
        const filePath = input.value.trim();
        if (!filePath) return;

        try {
            const resolveRes = await fetch('/api/resolve-model', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filePath })
            });

            if (!resolveRes.ok) {
                const err = await resolveRes.json();
                showError(err.error || 'Cannot resolve model path');
                return;
            }

            const result = await resolveRes.json();
            const fileName = filePath.split(/[/\\]/).pop();
            const labelEl = document.getElementById(target === 'dev' ? 'label-dev-file' : 'label-prod-file');
            labelEl.textContent = fileName;

            if (target === 'dev') {
                devPath = result.definitionPath;
                localStorage.setItem('ma_devPath', devPath);
                localStorage.setItem('ma_devFile', filePath);
            } else {
                prodPath = result.definitionPath;
                localStorage.setItem('ma_prodPath', prodPath);
                localStorage.setItem('ma_prodFile', filePath);
            }
        } catch (err) {
            showError(`Path resolve error: ${err.message}`);
        }
    }

    async function pickFile(target) {
        const btn = document.getElementById(target === 'dev' ? 'btn-browse-dev' : 'btn-browse-prod');
        btn.disabled = true;
        btn.textContent = '...';

        try {
            // Get initial directory from current input value (only if non-empty)
            const currentFile = (target === 'dev' ? devPathInput : prodPathInput).value.trim();
            const initialdir = currentFile ? currentFile.replace(/[/\\][^/\\]*$/, '') : '';

            // Open native file dialog via Python/tkinter
            let url = `/api/pick-file?target=${target}`;
            if (initialdir) url += `&initialdir=${encodeURIComponent(initialdir)}`;
            const pickRes = await fetch(url);
            const pickData = await pickRes.json();

            if (pickData.cancelled || !pickData.filePath) return;

            // Resolve the .pbip file to definition path
            const resolveRes = await fetch('/api/resolve-model', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filePath: pickData.filePath })
            });

            if (!resolveRes.ok) {
                const err = await resolveRes.json();
                showError(err.error || 'Cannot resolve model path');
                return;
            }

            const result = await resolveRes.json();
            const targetInput = target === 'dev' ? devPathInput : prodPathInput;
            targetInput.value = pickData.filePath;

            // Update label with filename
            const fileName = pickData.filePath.split(/[/\\]/).pop();
            const labelEl = document.getElementById(target === 'dev' ? 'label-dev-file' : 'label-prod-file');
            labelEl.textContent = fileName;

            if (target === 'dev') {
                devPath = result.definitionPath;
                localStorage.setItem('ma_devPath', devPath);
                localStorage.setItem('ma_devFile', pickData.filePath);
            } else {
                prodPath = result.definitionPath;
                localStorage.setItem('ma_prodPath', prodPath);
                localStorage.setItem('ma_prodFile', pickData.filePath);
            }
        } catch (err) {
            showError(`File picker error: ${err.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Browse';
        }
    }

    function restoreSavedPaths() {
        const savedDevFile = localStorage.getItem('ma_devFile');
        const savedProdFile = localStorage.getItem('ma_prodFile');

        if (savedDevFile) {
            devPathInput.value = savedDevFile;
            document.getElementById('label-dev-file').textContent = savedDevFile.split(/[/\\]/).pop();
        }
        if (savedProdFile) {
            prodPathInput.value = savedProdFile;
            document.getElementById('label-prod-file').textContent = savedProdFile.split(/[/\\]/).pop();
        }
    }

    function swapModels() {
        // Swap definition paths
        const tmpPath = devPath;
        devPath = prodPath;
        prodPath = tmpPath;

        // Swap display values
        const tmpInput = devPathInput.value;
        devPathInput.value = prodPathInput.value;
        prodPathInput.value = tmpInput;

        // Swap labels
        const labelDev = document.getElementById('label-dev-file');
        const labelProd = document.getElementById('label-prod-file');
        const tmpLabel = labelDev.textContent;
        labelDev.textContent = labelProd.textContent;
        labelProd.textContent = tmpLabel;

        // Persist
        localStorage.setItem('ma_devPath', devPath);
        localStorage.setItem('ma_prodPath', prodPath);
        localStorage.setItem('ma_devFile', devPathInput.value);
        localStorage.setItem('ma_prodFile', prodPathInput.value);
    }
})();
