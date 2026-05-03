import { workflow, node, links } from '@n8n-as-code/transformer';

// <workflow-map>
// Workflow : My workflow
// Nodes   : 1  |  Connections: 0
//
// NODE INDEX
// ──────────────────────────────────────────────────────────────────
// Property name                    Node type (short)         Flags
// WhenClickingExecuteWorkflow        manualTrigger              
//
// ROUTING MAP
// ──────────────────────────────────────────────────────────────────
// </workflow-map>

// =====================================================================
// METADATA DU WORKFLOW
// =====================================================================

@workflow({
    id: "t6BYu05Q2owPMe1v",
    name: "My workflow",
    active: false,
    isArchived: false,
    projectId: "pS22umvSFjKgMjvc",
    settings: { executionOrder: "v1", binaryMode: "separate" }
})
export class MyWorkflow {

    // =====================================================================
// CONFIGURATION DES NOEUDS
// =====================================================================

    @node({
        id: "343b9418-8aeb-43f3-8527-df6b978f545e",
        name: "When clicking ‘Execute workflow’",
        type: "n8n-nodes-base.manualTrigger",
        version: 1,
        position: [0, 0]
    })
    WhenClickingExecuteWorkflow = {};


    // =====================================================================
// ROUTAGE ET CONNEXIONS
// =====================================================================

    @links()
    defineRouting() {
        // No connections defined
    }
}