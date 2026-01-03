const assert = require("assert");

describe("Command interactions", () => {
    it("opens the command editor from the tree view", async () => {
        const workbench = await browser.getWorkbench();
        const activityBar = workbench.getActivityBar();
        const viewControl = await activityBar.getViewControl(
            "Commands Manager Next"
        );
        const view = await viewControl.openView();
        const tree = await view.getContent();
        const folders = await tree.getChildren();
        assert.ok(
            folders.length > 0,
            "Expected at least one folder in the command tree"
        );

        const folder = folders[0];
        await folder.expand();
        const commands = await folder.getChildren();
        assert.ok(
            commands.length > 0,
            "Expected at least one command in the sample folder"
        );

        const commandItem = commands[0];
        const commandLabel = await commandItem.getLabel();
        const menu = await commandItem.openContextMenu();
        await menu.select("Edit Command");

        const editorView = await workbench.getEditorView();
        await browser.waitUntil(
            async () => {
                const titles = await editorView.getOpenEditorTitles();
                return titles.includes(`Edit ${commandLabel}`);
            },
            { timeout: 15000, timeoutMsg: "Command editor did not open" }
        );

        const editor = await editorView.openEditor(`Edit ${commandLabel}`);
        if (typeof editor.switchToFrame !== "function") {
            throw new Error("Expected a webview editor");
        }
        await editor.switchToFrame();
        const form = await $("#command-form");
        await form.waitForExist({ timeout: 10000 });
        const preview = await $("#command-preview");
        assert.strictEqual(await preview.isExisting(), true);
        await editor.switchBack();
    });
});
