// Model Alchemist v4.1 — Frontend Application with Deploy, File Browser & Fabric
(function () {
    'use strict';

    // State
    let comparisonResult = null;
    let activeGroup = null;
    let activeFilter = 'all';
    let searchTerm = '';
    let selectedKeys = new Set();
    let devPath = localStorage.getItem('ma_devPath') || '';
    let prodPath = localStorage.getItem('ma_prodPath') || '';
    let fabricConnected = false;
    let workspacesCache = [];

    // Source mode: 'local' or 'fabric' for each side
    let devSourceMode = 'local';
    let prodSourceMode = 'local';
    let devFabricSelection = { workspaceId: null, semanticModelId: null, modelName: null };
    let prodFabricSelection = { workspaceId: null, semanticModelId: null, modelName: null };

    // DOM Elements
    const connectionPanel = document.getElementById('connection-panel');
    const resultsPanel = document.getElementById('results-panel');
    const devPathInput = document.getElementById('dev-path');
    const prodPathInput = document.getElementById('prod-path');
    const btnCompare = document.getElementById('btn-compare');
    const btnNewCompare = document.getElementById('btn-new-compare');
    const btnRefresh = document.getElementById('btn-refresh');
    const exportDropdown = document.getElementById('export-dropdown');
    const btnExport = document.getElementById('btn-export');
    const exportMenu = document.getElementById('export-menu');
    const btnDeploy = document.getElementById('btn-deploy');
    const deployCount = document.getElementById('deploy-count');
    const errorMessage = document.getElementById('error-message');
    const loading = document.getElementById('loading');
    const groupList = document.getElementById('group-list');
    const diffContent = document.getElementById('diff-content');
    const diffSearchInput = document.getElementById('diff-search');
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

    // Export dropdown
    btnExport.addEventListener('click', (e) => {
        e.stopPropagation();
        exportMenu.classList.toggle('open');
    });
    document.addEventListener('click', () => exportMenu.classList.remove('open'));
    exportMenu.addEventListener('click', (e) => {
        const format = e.target.dataset.format;
        if (format) { exportDiffs(format); exportMenu.classList.remove('open'); }
    });

    // File browser event listeners
    document.getElementById('btn-browse-dev').addEventListener('click', () => pickFile('dev'));
    document.getElementById('btn-browse-prod').addEventListener('click', () => pickFile('prod'));
    document.getElementById('btn-swap').addEventListener('click', swapModels);

    // Manual path edit - resolve on blur/enter
    devPathInput.addEventListener('change', () => resolveManualPath('dev'));
    prodPathInput.addEventListener('change', () => resolveManualPath('prod'));

    // Fabric event listeners
    document.getElementById('btn-fabric-connect').addEventListener('click', openFabricModal);
    document.getElementById('fabric-modal-close').addEventListener('click', closeFabricModal);
    document.getElementById('btn-fabric-login').addEventListener('click', handleFabricLogin);
    document.getElementById('btn-fabric-cancel-login').addEventListener('click', handleFabricCancelLogin);
    document.getElementById('btn-fabric-disconnect').addEventListener('click', handleFabricDisconnect);
    document.getElementById('btn-resolve-dev').addEventListener('click', () => resolveConnectionString('dev'));
    document.getElementById('btn-resolve-prod').addEventListener('click', () => resolveConnectionString('prod'));

    // Source tab switching
    document.querySelectorAll('.source-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            const target = e.target.closest('.source-tabs').dataset.target;
            const source = e.target.dataset.source;
            switchSourceTab(target, source);
        });
    });

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

    // Search input — filter diffs by name from 2nd character
    diffSearchInput.addEventListener('input', () => {
        searchTerm = diffSearchInput.value.trim();
        if (searchTerm.length >= 2) {
            renderDiffs();
        } else if (searchTerm.length === 0) {
            renderDiffs();
        }
    });

    // Close modals on backdrop click
    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
        backdrop.addEventListener('click', () => {
            deployModal.classList.add('hidden');
            resultModal.classList.add('hidden');
        });
    });

    async function handleCompare() {
        const devIsLocal = devSourceMode === 'local';
        const prodIsLocal = prodSourceMode === 'local';

        // Validate inputs
        if (devIsLocal && !devPath) {
            showError('Please select a DEV model file.');
            return;
        }
        if (!devIsLocal && !fabricConnected) {
            showError('Sign in to Fabric first (DEV source).');
            return;
        }
        if (!devIsLocal && !devFabricSelection.semanticModelId) {
            showError('Verify DEV connection string first (click "Verify Access").');
            return;
        }
        if (prodIsLocal && !prodPath) {
            showError('Please select a PROD model file.');
            return;
        }
        if (!prodIsLocal && !fabricConnected) {
            showError('Sign in to Fabric first (PROD source).');
            return;
        }
        if (!prodIsLocal && !prodFabricSelection.semanticModelId) {
            showError('Verify PROD connection string first (click "Verify Access").');
            return;
        }

        hideError();
        showLoading();

        try {
            let response;

            // If both are local, use the original endpoint
            if (devIsLocal && prodIsLocal) {
                response = await fetch('/api/compare', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ devPath, prodPath })
                });
            } else {
                // Use the fabric-aware comparison endpoint
                const devSource = devIsLocal
                    ? { type: 'local', path: devPath }
                    : { type: 'fabric', connectionString: devFabricSelection.connectionString, workspaceId: devFabricSelection.workspaceId, semanticModelId: devFabricSelection.semanticModelId };
                const prodSource = prodIsLocal
                    ? { type: 'local', path: prodPath }
                    : { type: 'fabric', connectionString: prodFabricSelection.connectionString, workspaceId: prodFabricSelection.workspaceId, semanticModelId: prodFabricSelection.semanticModelId };

                response = await fetch('/api/compare-fabric', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ devSource, prodSource })
                });
            }

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
        btnRefresh.disabled = true;
        btnRefresh.textContent = '⏳ Refreshing...';

        try {
            const devIsLocal = devSourceMode === 'local';
            const prodIsLocal = prodSourceMode === 'local';
            let response;

            if (devIsLocal && prodIsLocal) {
                if (!devPath || !prodPath) return;
                response = await fetch('/api/compare', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ devPath, prodPath })
                });
            } else {
                const devSource = devIsLocal
                    ? { type: 'local', path: devPath }
                    : { type: 'fabric', connectionString: devFabricSelection.connectionString, workspaceId: devFabricSelection.workspaceId, semanticModelId: devFabricSelection.semanticModelId };
                const prodSource = prodIsLocal
                    ? { type: 'local', path: prodPath }
                    : { type: 'fabric', connectionString: prodFabricSelection.connectionString, workspaceId: prodFabricSelection.workspaceId, semanticModelId: prodFabricSelection.semanticModelId };

                response = await fetch('/api/compare-fabric', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ devSource, prodSource })
                });
            }

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
        exportDropdown.classList.add('hidden');
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
        exportDropdown.classList.remove('hidden');
        btnDeploy.classList.remove('hidden');

        setModelInfo(devModelName, comparisonResult.devSource, devPathInput.value);
        setModelInfo(prodModelName, comparisonResult.prodSource, prodPathInput.value);

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

    function setModelInfo(el, source, inputPath) {
        if (!source) { el.textContent = ''; return; }
        // Fabric source: "Fabric: Workspace/Model"
        if (source.startsWith('Fabric:')) {
            const parts = source.replace('Fabric: ', '').split('/');
            const modelName = parts.pop();
            const workspace = parts.join('/');
            el.innerHTML = `<span class="model-filename">☁️ ${escapeHtml(modelName)}</span><span class="model-path">${escapeHtml(workspace)}</span>`;
        } else {
            // Local path: use .pbip file path from input if available
            const displayPath = inputPath || source;
            const sep = displayPath.includes('/') ? '/' : '\\';
            const segments = displayPath.split(sep);
            const fileName = segments.pop() || displayPath;
            const dirPath = segments.join(sep) + sep;
            el.innerHTML = `<span class="model-filename">📁 ${escapeHtml(fileName)}</span><span class="model-path">${escapeHtml(dirPath)}</span>`;
        }
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

        // Use summary from backend (includes all groups, even with zero count)
        const groups = comparisonResult.summary || {};

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
        const groups = comparisonResult.groups || [];

        if (activeGroup !== null) {
            diffs = diffs.filter(d => d.changeGroup === activeGroup);
        }
        if (activeFilter !== 'all') {
            const typeMap = { 'Added': 0, 'Removed': 1, 'Modified': 2 };
            diffs = diffs.filter(d => d.type === typeMap[activeFilter]);
        }
        if (searchTerm.length >= 2) {
            const term = searchTerm.toLowerCase();
            diffs = diffs.filter(d => d.displayName.toLowerCase().includes(term));
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

        diffs.sort((a, b) => a.displayName.localeCompare(b.displayName));

        // Build set of keys that belong to groups (for current visible diffs)
        const visibleKeys = new Set(diffs.map(d => d.identityKey));
        const groupedKeys = new Set();
        const activeGroups = groups.filter(g =>
            g.memberKeys.some(k => visibleKeys.has(k))
        );
        for (const g of activeGroups) {
            for (const k of g.memberKeys) groupedKeys.add(k);
        }

        diffContent.innerHTML = '';

        // Render atomic groups first
        for (const group of activeGroups) {
            const groupDiffs = diffs.filter(d => group.memberKeys.includes(d.identityKey));
            if (groupDiffs.length > 0) {
                diffContent.appendChild(createGroupElement(group, groupDiffs));
            }
        }

        // Render ungrouped diffs
        for (const diff of diffs) {
            if (!groupedKeys.has(diff.identityKey)) {
                diffContent.appendChild(createDiffElement(diff));
            }
        }
    }

    function createGroupElement(group, groupDiffs) {
        const container = document.createElement('div');
        container.className = 'diff-group';
        container.dataset.groupId = group.groupId;

        const allSelected = groupDiffs.every(d => selectedKeys.has(d.identityKey));
        const someSelected = groupDiffs.some(d => selectedKeys.has(d.identityKey));

        const groupIcon = group.isParameterGroup ? '⚡↻' : '↻';
        container.innerHTML = `
            <div class="diff-group-header">
                <div class="diff-checkbox-cell">
                    <input type="checkbox" class="diff-group-checkbox" ${allSelected ? 'checked' : ''} ${someSelected && !allSelected ? 'indeterminate' : ''} />
                </div>
                <div class="diff-group-info">
                    <span class="diff-group-icon">${groupIcon}</span>
                    <span class="diff-group-label">${escapeHtml(group.label)}</span>
                    <span class="diff-group-count">${groupDiffs.length} changes</span>
                    ${group.requiresRefresh ? '<span class="diff-group-badge">requires refresh</span>' : ''}
                </div>
                <span class="expand-indicator">▼</span>
            </div>
            <div class="diff-group-members"></div>
        `;

        const checkbox = container.querySelector('.diff-group-checkbox');
        if (someSelected && !allSelected) checkbox.indeterminate = true;

        // Group checkbox toggles all members
        checkbox.addEventListener('click', (e) => {
            e.stopPropagation();
            const shouldSelect = checkbox.checked;
            for (const diff of groupDiffs) {
                if (shouldSelect) {
                    selectedKeys.add(diff.identityKey);
                } else {
                    selectedKeys.delete(diff.identityKey);
                }
            }
            // Update member checkboxes
            container.querySelectorAll('.diff-checkbox').forEach(cb => {
                cb.checked = shouldSelect;
                cb.closest('.diff-object').classList.toggle('selected', shouldSelect);
            });
            checkbox.indeterminate = false;
            updateDeployButton();
        });

        // Expand/collapse group members
        const header = container.querySelector('.diff-group-header');
        const membersContainer = container.querySelector('.diff-group-members');
        header.addEventListener('click', (e) => {
            if (e.target.closest('.diff-checkbox-cell')) return;
            container.classList.toggle('expanded');
            if (container.classList.contains('expanded') && membersContainer.children.length === 0) {
                for (const diff of groupDiffs) {
                    const el = createDiffElement(diff, group);
                    membersContainer.appendChild(el);
                }
            }
        });

        return container;
    }

    function createDiffElement(diff, parentGroup) {
        const typeClass = diff.type === 0 ? 'added' : diff.type === 1 ? 'removed' : 'modified';
        const isSelected = selectedKeys.has(diff.identityKey);

        const container = document.createElement('div');
        container.className = `diff-object ${typeClass}${isSelected ? ' selected' : ''}`;
        container.dataset.key = diff.identityKey;

        let leftContent = '';
        let rightContent = '';

        if (diff.type === 0) {
            leftContent = `
                <span class="diff-object-name" title="${escapeAttr(diff.displayName)}">${escapeHtml(diff.displayName)}</span>
                <span class="diff-object-type">[${escapeHtml(diff.objectType)}]</span>
                <span class="diff-symbol">+</span>
                <span class="expand-indicator">▼</span>
            `;
        } else if (diff.type === 1) {
            rightContent = `
                <span class="diff-object-name" title="${escapeAttr(diff.displayName)}">${escapeHtml(diff.displayName)}</span>
                <span class="diff-object-type">[${escapeHtml(diff.objectType)}]</span>
                <span class="diff-symbol">−</span>
                <span class="expand-indicator">▼</span>
            `;
        } else {
            leftContent = `
                <span class="diff-object-name" title="${escapeAttr(diff.displayName)}">${escapeHtml(diff.displayName)}</span>
                <span class="diff-object-type">[${escapeHtml(diff.objectType)}]</span>
                <span class="diff-symbol">~</span>
                <span class="expand-indicator">▼</span>
            `;
            rightContent = `
                <span class="diff-object-name" title="${escapeAttr(diff.displayName)}">${escapeHtml(diff.displayName)}</span>
                <span class="diff-object-type">[${escapeHtml(diff.objectType)}]</span>
                <span class="diff-symbol">~</span>
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
            if (parentGroup) {
                // Inside a group: toggle ALL members together
                const shouldSelect = checkbox.checked;
                const groupContainer = container.closest('.diff-group');
                const groupDiffKeys = parentGroup.memberKeys;
                for (const key of groupDiffKeys) {
                    if (shouldSelect) selectedKeys.add(key);
                    else selectedKeys.delete(key);
                }
                // Update all member checkboxes in this group
                if (groupContainer) {
                    groupContainer.querySelectorAll('.diff-checkbox').forEach(cb => {
                        cb.checked = shouldSelect;
                        cb.closest('.diff-object').classList.toggle('selected', shouldSelect);
                    });
                    const groupCb = groupContainer.querySelector('.diff-group-checkbox');
                    if (groupCb) {
                        groupCb.checked = shouldSelect;
                        groupCb.indeterminate = false;
                    }
                }
            } else {
                // Standalone diff: toggle individually
                if (checkbox.checked) {
                    selectedKeys.add(diff.identityKey);
                    container.classList.add('selected');
                } else {
                    selectedKeys.delete(diff.identityKey);
                    container.classList.remove('selected');
                }
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
        // Select diffs whose checkboxes are currently rendered (i.e., visible after
        // applying activeGroup + activeFilter + searchTerm) AND all member keys of
        // any group checkbox that is currently displayed — even when the group is
        // collapsed and its member rows are not yet in the DOM. Without this,
        // collapsed atomic groups silently get dropped from the deploy payload.
        document.querySelectorAll('.diff-checkbox').forEach(cb => {
            cb.checked = true;
            const key = cb.dataset.key;
            selectedKeys.add(key);
            const diffObj = cb.closest('.diff-object');
            if (diffObj) diffObj.classList.add('selected');
        });

        const allGroups = (comparisonResult && comparisonResult.groups) || [];
        document.querySelectorAll('.diff-group-checkbox').forEach(cb => {
            cb.checked = true;
            cb.indeterminate = false;
            const groupId = cb.closest('.diff-group')?.dataset.groupId;
            if (!groupId) return;
            const group = allGroups.find(g => String(g.groupId) === String(groupId));
            if (!group) return;
            for (const k of group.memberKeys) selectedKeys.add(k);
        });
        updateDeployButton();
    }

    function deselectAll() {
        selectedKeys.clear();
        document.querySelectorAll('.diff-checkbox').forEach(cb => {
            cb.checked = false;
            const diffObj = cb.closest('.diff-object');
            if (diffObj) diffObj.classList.remove('selected');
        });
        document.querySelectorAll('.diff-group-checkbox').forEach(cb => {
            cb.checked = false;
            cb.indeterminate = false;
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

        // Check for partial group selections — warn user
        const groups = comparisonResult.groups || [];
        const partialGroups = [];
        for (const group of groups) {
            const selectedCount = group.memberKeys.filter(k => selectedKeys.has(k)).length;
            if (selectedCount > 0 && selectedCount < group.memberKeys.length) {
                partialGroups.push(group);
            }
        }
        if (partialGroups.length > 0) {
            const groupNames = partialGroups.map(g => g.label).join(', ');
            const proceed = confirm(
                `⚠️ Incomplete atomic groups selected: ${groupNames}\n\n` +
                `Deploying only part of Power Query changes may cause model refresh errors.\n\n` +
                `Do you want to continue anyway?`
            );
            if (!proceed) return;
        }

        // Show deploy modal with preview
        const selectedDiffs = comparisonResult.diffs.filter(d => selectedKeys.has(d.identityKey));
        const added = selectedDiffs.filter(d => d.type === 0).length;
        const removed = selectedDiffs.filter(d => d.type === 1).length;
        const modified = selectedDiffs.filter(d => d.type === 2).length;

        // Determine target label
        const targetLabel = prodSourceMode === 'fabric' && prodFabricSelection.modelName
            ? `☁️ Fabric: ${prodFabricSelection.modelName}`
            : prodPathInput.value;

        deploySummary.innerHTML = `
            <p>Deploying <span class="count-highlight">${selectedDiffs.length}</span> changes to PROD:</p>
            <p style="margin-left: 16px;">
                ${added ? `<span class="badge-count badge-added">${added} to add</span> ` : ''}
                ${removed ? `<span class="badge-count badge-removed">${removed} to remove</span> ` : ''}
                ${modified ? `<span class="badge-count badge-modified">${modified} to modify</span> ` : ''}
            </p>
            <p style="margin-top: 8px; font-size: 13px; color: var(--color-text-dim);">
                Target: <code>${escapeHtml(targetLabel)}</code>
            </p>
        `;

        // Show/hide backup path input based on source mode
        const backupPathRow = document.getElementById('backup-path-row');
        if (backupPathRow) {
            backupPathRow.classList.toggle('hidden', prodSourceMode === 'local');
        }

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
        const backupPathInput = document.getElementById('backup-path');
        const backupPathRow = document.getElementById('backup-path-row');

        // When the backup checkbox is checked AND the backup-path input is visible
        // (Fabric mode), the path must be non-empty — otherwise the user has no
        // way of knowing where the backup will be stored.
        if (optBackup.checked && backupPathRow && !backupPathRow.classList.contains('hidden')) {
            const val = backupPathInput && backupPathInput.value.trim();
            if (!val) {
                if (backupPathInput) {
                    backupPathInput.style.borderColor = 'var(--color-removed-text)';
                    backupPathInput.focus();
                }
                alert('Backup is enabled — please provide a backup folder path, or uncheck "Create backup before deployment".');
                return;
            }
            if (backupPathInput) backupPathInput.style.borderColor = '';
        }

        deployModal.classList.add('hidden');
        showAlchemistAnimation();

        try {
            const payload = {
                selectedKeys: [...selectedKeys],
                dryRun: false,
                backup: optBackup.checked
            };
            if (prodSourceMode === 'fabric' && optBackup.checked && backupPathInput && backupPathInput.value.trim()) {
                payload.backupPath = backupPathInput.value.trim();
            }

            const response = await fetch('/api/deploy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            hideAlchemistAnimation();
            showDeployResult(result);
        } catch (err) {
            hideAlchemistAnimation();
            showDeployResult({ success: false, errors: [{ error: err.message }], actions: [] });
        }
    }

    function showAlchemistAnimation() {
        let overlay = document.getElementById('deploy-animation-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'deploy-animation-overlay';
            overlay.className = 'deploy-animation-overlay';
            overlay.innerHTML = `
                <div class="alchemist-animation">
                    <div class="alchemist-flask">
                        <span class="flask-icon">⚗️</span>
                        <div class="flask-bubbles">
                            <span class="bubble b1"></span>
                            <span class="bubble b2"></span>
                            <span class="bubble b3"></span>
                        </div>
                    </div>
                    <p class="alchemist-text">Deploying changes...</p>
                    <p class="alchemist-subtext">Mixing the elixir of transformation</p>
                </div>
            `;
            document.body.appendChild(overlay);
        }
        overlay.classList.remove('hidden');
    }

    function hideAlchemistAnimation() {
        const overlay = document.getElementById('deploy-animation-overlay');
        if (overlay) overlay.classList.add('hidden');
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
            const deployActions = result.actions.filter(a => a.type !== 'backup');
            if (deployActions.length > 0) {
                html += `<p style="font-weight: 600; margin-bottom: 8px;">${deployActions.length} operations executed:</p>`;
                html += '<div class="result-actions">';
                for (const action of deployActions) {
                    // Some actions (e.g. type='fabric-upload') carry only a message
                    // and have no action/objectType/name — render the message instead
                    // of an empty "[]" placeholder.
                    if (action.message && !action.action && !action.objectType && !action.name) {
                        html += `<div class="result-action-item">✓ ${escapeHtml(action.message)}</div>`;
                    } else {
                        html += `<div class="result-action-item">✓ ${escapeHtml(action.action || '')} [${escapeHtml(action.objectType || '')}] ${escapeHtml(action.name || '')}</div>`;
                    }
                }
                html += '</div>';
            }
        }

        if (result.errors && result.errors.length > 0) {
            html += `<p style="font-weight: 600; margin-top: 16px; color: var(--color-removed-text);">Errors:</p>`;
            html += '<div class="result-actions">';
            for (const err of result.errors) {
                html += `<div class="result-action-item" style="border-left: 3px solid var(--color-removed-text);">✗ ${escapeHtml(err.error || JSON.stringify(err))}</div>`;
            }
            html += '</div>';
        }

        // Offer refresh for Fabric deployments with data-affecting changes
        if (result.success && result.tablesNeedingRefresh !== undefined) {
            const tables = result.tablesNeedingRefresh;
            const isFullRefresh = tables.length === 0;
            const tableLabel = isFullRefresh
                ? 'Full model refresh (Named Expressions changed)'
                : tables.map(t => `<code>${escapeHtml(t)}</code>`).join(', ');

            html += `<div id="refresh-offer" style="margin-top: 20px; padding: 16px; background: rgba(78, 154, 241, 0.08); border: 1px solid rgba(78, 154, 241, 0.3); border-radius: 8px;">`;
            html += `<p style="font-weight: 600; margin-bottom: 8px;">↻ Refresh Required</p>`;
            html += `<p style="font-size: 13px; margin-bottom: 12px;">Deployed changes affect data sources and require a model refresh to take effect.</p>`;
            html += `<p style="font-size: 12px; margin-bottom: 12px; opacity: 0.8;">Tables: ${tableLabel}</p>`;
            html += `<button id="btn-trigger-refresh" class="btn btn-primary" style="margin-right: 8px;">🔄 Refresh Now</button>`;
            html += `<button id="btn-skip-refresh" class="btn btn-secondary">Skip</button>`;
            html += `<div id="refresh-status" style="margin-top: 12px; display: none;"></div>`;
            html += `</div>`;
        }

        bodyEl.innerHTML = html;
        resultModal.classList.remove('hidden');

        // Bind refresh buttons if present
        const btnRefresh = document.getElementById('btn-trigger-refresh');
        const btnSkip = document.getElementById('btn-skip-refresh');
        if (btnRefresh) {
            const tables = result.tablesNeedingRefresh;
            btnRefresh.addEventListener('click', () => triggerFabricRefresh(tables));
            btnSkip.addEventListener('click', () => {
                document.getElementById('refresh-offer').style.display = 'none';
            });
        }
    }

    // ===== Fabric Refresh =====

    // Build the inner HTML used while a Fabric refresh is running. The caller
    // owns the elapsed-time interval; we render the spinner + label here.
    function refreshProgressHtml(label, elapsedSec) {
        const mm = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
        const ss = String(elapsedSec % 60).padStart(2, '0');
        return `<span class="refresh-spinner-inline" aria-hidden="true"></span>` +
               `<span style="color: var(--color-text-muted); margin-left: 8px;">${escapeHtml(label)}</span>` +
               `<span class="refresh-timer" style="margin-left: 12px; font-variant-numeric: tabular-nums; opacity: 0.8;">${mm}:${ss}</span>`;
    }

    function startRefreshTimer(statusEl, label) {
        // Stop any existing timer attached to this element
        stopRefreshTimer(statusEl);
        const startTs = Date.now();
        const render = () => {
            const elapsed = Math.floor((Date.now() - startTs) / 1000);
            statusEl.innerHTML = refreshProgressHtml(label, elapsed);
        };
        render();
        statusEl._refreshTimerId = setInterval(render, 1000);
        statusEl._refreshTimerLabel = label;
        statusEl._refreshTimerStart = startTs;
    }

    function stopRefreshTimer(statusEl) {
        if (statusEl && statusEl._refreshTimerId) {
            clearInterval(statusEl._refreshTimerId);
            statusEl._refreshTimerId = null;
        }
    }

    async function triggerFabricRefresh(tables) {
        const statusEl = document.getElementById('refresh-status');
        const btnRefresh = document.getElementById('btn-trigger-refresh');
        const btnSkip = document.getElementById('btn-skip-refresh');

        btnRefresh.disabled = true;
        btnSkip.style.display = 'none';
        statusEl.style.display = 'block';
        startRefreshTimer(statusEl, 'Starting refresh...');

        try {
            const response = await fetch('/api/fabric/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tables })
            });
            const result = await response.json();

            if (!response.ok || !result.success) {
                stopRefreshTimer(statusEl);
                statusEl.innerHTML = `<span style="color: var(--color-removed-text);">✗ ${escapeHtml(result.error || 'Refresh failed')}</span>`;
                btnRefresh.disabled = false;
                btnSkip.style.display = '';
                return;
            }

            if (result.requestId) {
                startRefreshTimer(statusEl, 'Refresh in progress...');
                pollRefreshStatus(result.requestId, statusEl, btnRefresh);
            } else {
                stopRefreshTimer(statusEl);
                statusEl.innerHTML = '<span style="color: var(--color-added-text);">✓ Refresh triggered (no tracking ID returned)</span>';
            }
        } catch (err) {
            stopRefreshTimer(statusEl);
            statusEl.innerHTML = `<span style="color: var(--color-removed-text);">✗ ${escapeHtml(err.message)}</span>`;
            btnRefresh.disabled = false;
            btnSkip.style.display = '';
        }
    }

    async function pollRefreshStatus(requestId, statusEl, btnRefresh) {
        const startTime = Date.now();
        const maxPollTime = 60 * 60 * 1000; // 60 minutes max polling

        const poll = async () => {
            if (Date.now() - startTime > maxPollTime) {
                stopRefreshTimer(statusEl);
                statusEl.innerHTML = '<span style="color: var(--color-text-muted);">⏳ Refresh still running (polling stopped after 60 min) — check Fabric portal for status.</span>';
                btnRefresh.style.display = 'none';
                return;
            }

            try {
                const response = await fetch(`/api/fabric/refresh/status/${requestId}`);
                const data = await response.json();

                if (data.status === 'Completed') {
                    stopRefreshTimer(statusEl);
                    statusEl.innerHTML = '<span style="color: var(--color-added-text);">✓ Refresh completed successfully!</span>';
                    btnRefresh.style.display = 'none';
                    return;
                } else if (data.status === 'Failed') {
                    stopRefreshTimer(statusEl);
                    const errMsg = data.serviceExceptionJson || 'Unknown error';
                    statusEl.innerHTML = `<span style="color: var(--color-removed-text);">✗ Refresh failed: ${escapeHtml(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg))}</span>`;
                    btnRefresh.disabled = false;
                    btnRefresh.textContent = '🔄 Retry';
                    return;
                } else if (data.status === 'Cancelled' || data.status === 'Disabled') {
                    stopRefreshTimer(statusEl);
                    statusEl.innerHTML = `<span style="color: var(--color-text-muted);">⚠ Refresh ${data.status.toLowerCase()}</span>`;
                    btnRefresh.disabled = false;
                    return;
                }

                // Still running — timer keeps ticking; just schedule the next poll.
                setTimeout(poll, 5000);
            } catch (err) {
                // Keep the timer running; surface the polling error briefly via title.
                if (statusEl) statusEl.title = `status check failed: ${err.message}`;
                setTimeout(poll, 10000);
            }
        };

        setTimeout(poll, 5000); // First check after 5s
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

    function escapeAttr(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

        // Swap source modes
        const tmpMode = devSourceMode;
        devSourceMode = prodSourceMode;
        prodSourceMode = tmpMode;

        // Swap fabric selections
        const tmpFabric = { ...devFabricSelection };
        devFabricSelection = { ...prodFabricSelection };
        prodFabricSelection = tmpFabric;

        // Persist
        localStorage.setItem('ma_devPath', devPath);
        localStorage.setItem('ma_prodPath', prodPath);
        localStorage.setItem('ma_devFile', devPathInput.value);
        localStorage.setItem('ma_prodFile', prodPathInput.value);
    }

    // ===== Fabric Integration =====

    function openFabricModal() {
        const modal = document.getElementById('fabric-modal');
        modal.classList.remove('hidden');
        checkFabricStatus();
    }

    function closeFabricModal() {
        document.getElementById('fabric-modal').classList.add('hidden');
    }

    async function checkFabricStatus() {
        try {
            const res = await fetch('/api/fabric/status');
            const data = await res.json();

            if (data.status === 'connected') {
                showFabricConnected(data.account);
            } else if (data.status === 'pending') {
                showFabricPending();
            }
        } catch { /* ignore */ }
    }

    async function handleFabricLogin() {
        hideFabricError();
        showFabricPending();

        try {
            const res = await fetch('/api/fabric/login', { method: 'POST' });
            const data = await res.json();

            if (data.status === 'connected') {
                showFabricConnected(data.account);
            } else if (data.status === 'pending') {
                // Login already in progress (browser window is open)
                pollFabricStatus();
            } else if (data.error) {
                showFabricError(data.error);
                resetFabricModal();
            }
        } catch (err) {
            showFabricError(`Login error: ${err.message}`);
            resetFabricModal();
        }
    }

    function pollFabricStatus() {
        const interval = setInterval(async () => {
            try {
                const res = await fetch('/api/fabric/status');
                const data = await res.json();
                if (data.status === 'connected') {
                    clearInterval(interval);
                    showFabricConnected(data.account);
                } else if (data.status === 'disconnected') {
                    clearInterval(interval);
                    resetFabricModal();
                }
            } catch { /* continue polling */ }
        }, 2000);
        // Stop polling after 5 minutes
        setTimeout(() => clearInterval(interval), 300000);
    }

    async function handleFabricCancelLogin() {
        try {
            await fetch('/api/fabric/cancel-login', { method: 'POST' });
        } catch { /* ignore */ }
        resetFabricModal();
    }

    function showFabricPending() {
        document.getElementById('fabric-auth-form').classList.add('hidden');
        document.getElementById('fabric-auth-pending').classList.remove('hidden');
        document.getElementById('fabric-auth-success').classList.add('hidden');
    }

    function showFabricConnected(account) {
        fabricConnected = true;
        const displayName = account?.username || account?.name || 'User';
        document.getElementById('fabric-auth-form').classList.add('hidden');
        document.getElementById('fabric-auth-pending').classList.add('hidden');
        document.getElementById('fabric-auth-success').classList.remove('hidden');
        document.getElementById('fabric-user-name').textContent = displayName;
        document.getElementById('fabric-status-dot').className = 'status-dot connected';

        // Show account in header
        const badge = document.getElementById('fabric-account-badge');
        badge.textContent = `👤 ${displayName}`;
        badge.classList.remove('hidden');

        // Show connection string inputs in source tabs
        enableFabricSelectors();
    }

    async function handleFabricDisconnect() {
        try {
            await fetch('/api/fabric/disconnect', { method: 'POST' });
        } catch { /* ignore */ }

        fabricConnected = false;
        devFabricSelection = { workspaceId: null, semanticModelId: null, modelName: null };
        prodFabricSelection = { workspaceId: null, semanticModelId: null, modelName: null };
        document.getElementById('fabric-status-dot').className = 'status-dot disconnected';
        document.getElementById('fabric-account-badge').classList.add('hidden');
        document.getElementById('fabric-status-dev').textContent = '';
        document.getElementById('fabric-status-prod').textContent = '';
        disableFabricSelectors();
        resetFabricModal();
        closeFabricModal();
    }

    function resetFabricModal() {
        document.getElementById('fabric-auth-form').classList.remove('hidden');
        document.getElementById('fabric-auth-pending').classList.add('hidden');
        document.getElementById('fabric-auth-success').classList.add('hidden');
        hideFabricError();
    }

    function showFabricError(msg) {
        const el = document.getElementById('fabric-error');
        el.textContent = msg;
        el.classList.remove('hidden');
    }

    function hideFabricError() {
        document.getElementById('fabric-error').classList.add('hidden');
    }

    async function resolveConnectionString(target) {
        const connStr = document.getElementById(`${target}-conn-string`).value.trim();
        const statusEl = document.getElementById(`fabric-status-${target}`);

        if (!connStr) {
            statusEl.textContent = '⚠️ Paste a connection string first.';
            statusEl.className = 'fabric-resolve-status error';
            return;
        }

        statusEl.textContent = 'Verifying...';
        statusEl.className = 'fabric-resolve-status';

        try {
            const res = await fetch('/api/fabric/resolve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connectionString: connStr })
            });

            const data = await res.json();

            if (!res.ok) {
                statusEl.textContent = `✗ ${data.error}`;
                statusEl.className = 'fabric-resolve-status error';
                return;
            }

            // Store resolved IDs for comparison
            const selection = {
                workspaceId: data.workspaceId,
                semanticModelId: data.semanticModelId,
                modelName: data.modelName,
                connectionString: connStr
            };

            if (target === 'dev') {
                devFabricSelection = selection;
                document.getElementById('label-dev-file').textContent = `☁️ ${data.modelName}`;
            } else {
                prodFabricSelection = selection;
                document.getElementById('label-prod-file').textContent = `☁️ ${data.modelName}`;
            }

            statusEl.textContent = `✓ ${data.workspaceName} / ${data.modelName}`;
            statusEl.className = 'fabric-resolve-status success';

            // Save connection string
            localStorage.setItem(`ma_fabric_${target}_connStr`, connStr);
        } catch (err) {
            statusEl.textContent = `✗ ${err.message}`;
            statusEl.className = 'fabric-resolve-status error';
        }
    }

    function switchSourceTab(target, source) {
        const tabs = document.querySelectorAll(`.source-tabs[data-target="${target}"] .source-tab`);
        tabs.forEach(t => t.classList.remove('active'));
        document.querySelector(`.source-tabs[data-target="${target}"] .source-tab[data-source="${source}"]`).classList.add('active');

        const contents = document.querySelectorAll(`.source-content[data-target="${target}"]`);
        contents.forEach(c => c.classList.remove('active'));
        document.querySelector(`.source-content.source-${source}[data-target="${target}"]`).classList.add('active');

        if (target === 'dev') {
            devSourceMode = source;
            const labelEl = document.getElementById('label-dev-file');
            if (source === 'fabric' && devFabricSelection.modelName) {
                labelEl.textContent = `☁️ ${devFabricSelection.modelName}`;
            } else if (source === 'local') {
                const savedFile = localStorage.getItem('ma_devFile');
                labelEl.textContent = savedFile ? savedFile.split(/[/\\]/).pop() : '—';
            }
        } else {
            prodSourceMode = source;
            const labelEl = document.getElementById('label-prod-file');
            if (source === 'fabric' && prodFabricSelection.modelName) {
                labelEl.textContent = `☁️ ${prodFabricSelection.modelName}`;
            } else if (source === 'local') {
                const savedFile = localStorage.getItem('ma_prodFile');
                labelEl.textContent = savedFile ? savedFile.split(/[/\\]/).pop() : '—';
            }
        }
    }

    function enableFabricSelectors() {
        const hintDev = document.getElementById('fabric-hint-dev');
        const hintProd = document.getElementById('fabric-hint-prod');
        const selectsDev = document.getElementById('fabric-selects-dev');
        const selectsProd = document.getElementById('fabric-selects-prod');

        if (hintDev) hintDev.classList.add('hidden');
        if (hintProd) hintProd.classList.add('hidden');
        if (selectsDev) selectsDev.classList.remove('hidden');
        if (selectsProd) selectsProd.classList.remove('hidden');

        // Restore saved connection strings
        const savedDev = localStorage.getItem('ma_fabric_dev_connStr');
        const savedProd = localStorage.getItem('ma_fabric_prod_connStr');
        if (savedDev) document.getElementById('dev-conn-string').value = savedDev;
        if (savedProd) document.getElementById('prod-conn-string').value = savedProd;
    }

    function disableFabricSelectors() {
        const hintDev = document.getElementById('fabric-hint-dev');
        const hintProd = document.getElementById('fabric-hint-prod');
        const selectsDev = document.getElementById('fabric-selects-dev');
        const selectsProd = document.getElementById('fabric-selects-prod');

        if (hintDev) hintDev.classList.remove('hidden');
        if (hintProd) hintProd.classList.remove('hidden');
        if (selectsDev) selectsDev.classList.add('hidden');
        if (selectsProd) selectsProd.classList.add('hidden');
    }

    // Restore saved fabric connection string and username
    // Check if already connected on page load
    checkFabricStatus();

    // Close fabric modal on backdrop click
    document.querySelector('#fabric-modal .modal-backdrop')?.addEventListener('click', closeFabricModal);

    // ===== Export Functions =====

    function exportDiffs(format) {
        if (!comparisonResult || !comparisonResult.diffs) return;

        const diffs = comparisonResult.diffs;
        const typeNames = { 0: 'Added', 1: 'Removed', 2: 'Modified' };
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const devSource = comparisonResult.devSource || 'DEV';
        const prodSource = comparisonResult.prodSource || 'PROD';
        const modelName = (comparisonResult.devModelName || comparisonResult.prodModelName || 'Model').replace(/[^a-zA-Z0-9_\-]/g, '_');

        let content, filename, mimeType;

        if (format === 'csv') {
            // Part 1: Summary
            const rows = [['=== SUMMARY ==='], ['Group', 'Change Type', 'Object Type', 'Name']];
            for (const d of diffs) {
                rows.push([
                    d.changeGroup || '',
                    typeNames[d.type] || '',
                    d.objectType || '',
                    d.displayName || ''
                ]);
            }
            // Part 2: Details
            rows.push([]);
            rows.push(['=== DETAILS ===']);
            rows.push(['Object', 'Change Type', 'Property', 'DEV Value', 'PROD Value']);
            for (const d of diffs) {
                const props = d.propertyDiffs || [];
                if (props.length === 0) {
                    rows.push([d.displayName || '', typeNames[d.type], '', '', '']);
                } else {
                    for (const p of props) {
                        rows.push([
                            d.displayName || '',
                            typeNames[d.type],
                            p.propertyName || '',
                            formatExportValue(p.devValue),
                            formatExportValue(p.prodValue)
                        ]);
                    }
                }
            }
            content = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
            filename = `${modelName}_diff_${timestamp}.csv`;
            mimeType = 'text/csv;charset=utf-8;';
        } else if (format === 'markdown') {
            // Part 1: Summary
            let md = `# Model Comparison Report: ${modelName}\n\n`;
            md += `**Date:** ${new Date().toLocaleString()}\n\n`;
            md += `**DEV:** ${devSource}\n\n`;
            md += `**PROD:** ${prodSource}\n\n`;
            md += `**Total differences:** ${diffs.length}\n\n`;
            md += `## Summary\n\n`;
            md += `| # | Group | Type | Object | Name |\n`;
            md += `|---|-------|------|--------|------|\n`;
            diffs.forEach((d, i) => {
                md += `| ${i + 1} | ${d.changeGroup || ''} | ${typeNames[d.type]} | ${d.objectType || ''} | ${d.displayName || ''} |\n`;
            });
            // Part 2: Details
            md += `\n---\n\n## Details\n\n`;
            for (const d of diffs) {
                md += `### ${typeNames[d.type]}: [${d.objectType}] ${d.displayName}\n\n`;
                const props = d.propertyDiffs || [];
                if (props.length === 0) {
                    md += `_No property details_\n\n`;
                } else {
                    // Separate code properties (expression) from simple properties
                    const codeProps = props.filter(p => p.propertyName === 'expression' || p.propertyName === 'source');
                    const simpleProps = props.filter(p => p.propertyName !== 'expression' && p.propertyName !== 'source');

                    // Simple properties as side-by-side table
                    if (simpleProps.length > 0) {
                        md += `| Property | Source (DEV) | Target (PROD) |\n`;
                        md += `|----------|-------------|---------------|\n`;
                        for (const p of simpleProps) {
                            const devStr = p.devValue != null ? String(p.devValue).replace(/\|/g, '\\|') : '\u2014';
                            const prodStr = p.prodValue != null ? String(p.prodValue).replace(/\|/g, '\\|') : '\u2014';
                            md += `| ${p.propertyName} | ${devStr} | ${prodStr} |\n`;
                        }
                        md += `\n`;
                    }

                    // Code properties as fenced code blocks
                    const stripFence = (v) => String(v).replace(/^[\n\r]*```\n?/, '').replace(/\n?```[\n\r]*$/, '').replace(/^\n+/, '');
                    for (const p of codeProps) {
                        md += `**${p.propertyName}**\n\n`;
                        if (p.devValue != null) {
                            md += `Source (DEV):\n\`\`\`\n${stripFence(p.devValue)}\n\`\`\`\n\n`;
                        }
                        if (p.prodValue != null) {
                            md += `Target (PROD):\n\`\`\`\n${stripFence(p.prodValue)}\n\`\`\`\n\n`;
                        }
                    }
                }
            }
            content = md;
            filename = `${modelName}_diff_${timestamp}.md`;
            mimeType = 'text/markdown;charset=utf-8;';
        } else if (format === 'html') {
            let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Model Comparison: ${escapeHtml(modelName)}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 1400px; margin: 0 auto; padding: 24px; background: #1a1a2e; color: #e0e0e0; }
h1 { color: #4cc9f0; }
h2 { color: #a0a0d0; margin-top: 40px; border-bottom: 1px solid #333; padding-bottom: 8px; }
h3 { color: #ccc; margin-top: 24px; }
table { width: 100%; border-collapse: collapse; margin-top: 16px; }
th { background: #2a2a4e; padding: 10px 12px; text-align: left; border-bottom: 2px solid #4cc9f0; }
td { padding: 8px 12px; border-bottom: 1px solid #333; }
tr:hover { background: #2a2a3e; }
.badge { padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
.badge-added { background: rgba(80,200,120,0.2); color: #50c878; }
.badge-removed { background: rgba(255,100,100,0.2); color: #ff6464; }
.badge-modified { background: rgba(255,200,50,0.2); color: #ffc832; }
.summary { display: flex; gap: 16px; margin: 16px 0; }
.summary span { padding: 4px 12px; border-radius: 4px; }
.detail-item { margin: 20px 0; padding: 16px; background: #222244; border-radius: 8px; border-left: 4px solid #4cc9f0; }
.detail-item.added { border-left-color: #50c878; }
.detail-item.removed { border-left-color: #ff6464; }
.detail-item.modified { border-left-color: #ffc832; }
.prop-name { font-weight: 600; color: #4cc9f0; margin-top: 12px; margin-bottom: 4px; }
.prop-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 8px; }
.prop-col { min-width: 0; }
.prop-col-header { font-size: 11px; text-transform: uppercase; color: #888; margin-bottom: 4px; font-weight: 600; }
.prop-value { background: #1a1a3e; padding: 8px 12px; border-radius: 4px; font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; overflow-x: auto; min-height: 32px; }
.prop-value.source { border-left: 3px solid #50c878; }
.prop-value.target { border-left: 3px solid #ff6464; }
.prop-value.empty { color: #555; font-style: italic; }
.label { font-size: 11px; text-transform: uppercase; color: #888; margin-top: 8px; }
</style></head><body>
<h1>Model Comparison: ${escapeHtml(modelName)}</h1>
<p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
<p><strong>DEV:</strong> ${escapeHtml(devSource)}</p>
<p><strong>PROD:</strong> ${escapeHtml(prodSource)}</p>
<div class="summary">
<span class="badge badge-added">${diffs.filter(d => d.type === 0).length} Added</span>
<span class="badge badge-removed">${diffs.filter(d => d.type === 1).length} Removed</span>
<span class="badge badge-modified">${diffs.filter(d => d.type === 2).length} Modified</span>
</div>

<h2>Summary</h2>
<table><thead><tr><th>#</th><th>Group</th><th>Type</th><th>Object</th><th>Name</th></tr></thead><tbody>`;
            diffs.forEach((d, i) => {
                const cls = d.type === 0 ? 'added' : d.type === 1 ? 'removed' : 'modified';
                html += `<tr><td>${i + 1}</td><td>${escapeHtml(d.changeGroup || '')}</td><td><span class="badge badge-${cls}">${typeNames[d.type]}</span></td><td>${escapeHtml(d.objectType || '')}</td><td>${escapeHtml(d.displayName || '')}</td></tr>`;
            });
            html += `</tbody></table>

<h2>Details</h2>`;
            for (const d of diffs) {
                const cls = d.type === 0 ? 'added' : d.type === 1 ? 'removed' : 'modified';
                html += `<div class="detail-item ${cls}">`;
                html += `<h3><span class="badge badge-${cls}">${typeNames[d.type]}</span> [${escapeHtml(d.objectType)}] ${escapeHtml(d.displayName)}</h3>`;
                const props = d.propertyDiffs || [];
                if (props.length === 0) {
                    html += `<p style="color:#888;">No property details</p>`;
                } else {
                    for (const p of props) {
                        html += `<div class="prop-name">${escapeHtml(p.propertyName)}</div>`;
                        html += `<div class="prop-row">`;
                        html += `<div class="prop-col"><div class="prop-col-header">Source (DEV)</div>`;
                        html += p.devValue != null
                            ? `<div class="prop-value source">${escapeHtml(String(p.devValue))}</div>`
                            : `<div class="prop-value empty">—</div>`;
                        html += `</div>`;
                        html += `<div class="prop-col"><div class="prop-col-header">Target (PROD)</div>`;
                        html += p.prodValue != null
                            ? `<div class="prop-value target">${escapeHtml(String(p.prodValue))}</div>`
                            : `<div class="prop-value empty">—</div>`;
                        html += `</div>`;
                        html += `</div>`;
                    }
                }
                html += `</div>`;
            }
            html += `</body></html>`;
            content = html;
            filename = `${modelName}_diff_${timestamp}.html`;
            mimeType = 'text/html;charset=utf-8;';
        }

        // Trigger download
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function formatExportValue(val) {
        if (val == null) return '';
        return String(val).replace(/\r?\n/g, ' ↵ ');
    }
})();
