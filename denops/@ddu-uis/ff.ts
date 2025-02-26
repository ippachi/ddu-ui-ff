import {
  ActionFlags,
  BaseUi,
  Context,
  DduItem,
  DduOptions,
  ExpandItem,
  UiActions,
  UiOptions,
} from "https://deno.land/x/ddu_vim@v1.12.0/types.ts";
import {
  batch,
  Denops,
  fn,
  op,
  vars,
} from "https://deno.land/x/ddu_vim@v1.12.0/deps.ts";
import { PreviewUi } from "../@ddu-ui-ff/preview.ts";
import { dirname } from "https://deno.land/std@0.160.0/path/mod.ts";

type DoActionParams = {
  name?: string;
  items?: DduItem[];
  params?: unknown;
};

type HighlightGroup = {
  floating?: string;
  prompt?: string;
  selected?: string;
};

type AutoAction = {
  name?: string;
  params?: unknown;
};

type FloatingBorder =
  | "none"
  | "single"
  | "double"
  | "rounded"
  | "solid"
  | "shadow"
  | string[];

type SaveCursor = {
  pos: number[];
  text: string;
};

export type ActionData = {
  isDirectory?: boolean;
  path?: string;
};

type ExpandItemParams = {
  mode?: "toggle";
  maxLevel?: number;
};

export type Params = {
  autoAction: AutoAction;
  autoResize: boolean;
  cursorPos: number;
  displaySourceName: "long" | "short" | "no";
  floatingBorder: FloatingBorder;
  filterFloatingPosition: "top" | "bottom";
  filterSplitDirection: "botright" | "topleft" | "floating";
  filterUpdateTime: number;
  highlights: HighlightGroup;
  ignoreEmpty: boolean;
  previewCol: number;
  previewFloating: boolean;
  previewHeight: number;
  previewRow: number;
  previewVertical: boolean;
  previewWidth: number;
  previewFloatingBorder: FloatingBorder;
  previewFloatingZindex: number;
  prompt: string;
  reversed: boolean;
  split: "horizontal" | "vertical" | "floating" | "no";
  splitDirection: "botright" | "topleft";
  startFilter: boolean;
  statusline: boolean;
  winCol: number;
  winHeight: number;
  winRow: number;
  winWidth: number;
};

export class Ui extends BaseUi<Params> {
  private buffers: Record<string, number> = {};
  private filterBufnr = -1;
  private items: DduItem[] = [];
  private viewItems: DduItem[] = [];
  private selectedItems: Set<number> = new Set();
  private expandedPaths: Set<string> = new Set();
  private saveMode = "";
  private checkEnd = false;
  private refreshed = false;
  private prevLength = -1;
  private previewUi = new PreviewUi();

  async onInit(args: {
    denops: Denops;
  }): Promise<void> {
    this.saveMode = await fn.mode(args.denops);
    this.checkEnd =
      await fn.col(args.denops, "$") == await fn.col(args.denops, ".");
    this.filterBufnr = -1;
  }

  // deno-lint-ignore require-await
  async refreshItems(args: {
    items: DduItem[];
  }): Promise<void> {
    // NOTE: Use only 1000 items
    this.prevLength = this.items.length;
    this.items = args.items.slice(0, 1000);
    this.selectedItems.clear();
    this.refreshed = true;
  }

  async searchItem(args: {
    denops: Denops;
    item: DduItem;
  }) {
    const pos = this.items.findIndex((item) => item == args.item);

    if (pos > 0) {
      await fn.cursor(args.denops, pos + 1, 0);
      await args.denops.cmd("normal! zz");
    }
  }

  async searchPath(args: {
    denops: Denops;
    path: string;
  }) {
    const pos = this.items.findIndex(
      (item) => args.path == (item?.action as ActionData).path ?? item.word,
    );

    if (pos > 0) {
      await fn.cursor(args.denops, pos + 1, 0);
      await args.denops.cmd("normal! zz");
    }
  }

  async redraw(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiOptions: UiOptions;
    uiParams: Params;
  }): Promise<void> {
    if (args.options.sync && !args.context.done) {
      // Skip redraw if all items are not done
      return;
    }

    if (this.items.length == 0) {
      // Close preview window when empty items
      await this.previewUi.close(args.denops);
    }

    if (
      this.prevLength < 0 && args.uiParams.ignoreEmpty &&
      args.context.maxItems == 0
    ) {
      // Disable redraw when empty items
      return;
    }

    const bufferName = `ddu-ff-${args.options.name}`;
    const initialized = this.buffers[args.options.name] ||
      (await fn.bufexists(args.denops, bufferName) &&
        await fn.bufnr(args.denops, bufferName));
    const bufnr = initialized || await this.initBuffer(args.denops, bufferName);

    await this.setDefaultParams(args.denops, args.uiParams);

    const hasNvim = args.denops.meta.host == "nvim";
    const floating = args.uiParams.split == "floating" && hasNvim;
    const winHeight = args.uiParams.autoResize &&
        this.items.length < Number(args.uiParams.winHeight)
      ? Math.max(this.items.length, 1)
      : Number(args.uiParams.winHeight);
    const winid = await fn.bufwinid(args.denops, bufnr);
    if (winid < 0) {
      const direction = args.uiParams.splitDirection;
      if (args.uiParams.split == "horizontal") {
        const header = `silent keepalt ${direction} `;
        await args.denops.cmd(
          header + `sbuffer +resize\\ ${winHeight} ${bufnr}`,
        );
      } else if (args.uiParams.split == "vertical") {
        const header = `silent keepalt vertical ${direction} `;
        await args.denops.cmd(
          header +
            `sbuffer +vertical\\ resize\\ ${args.uiParams.winWidth} ${bufnr}`,
        );
      } else if (floating) {
        // statusline must be set for floating window
        const currentStatusline = await op.statusline.get(args.denops);

        await args.denops.call("nvim_open_win", bufnr, true, {
          "relative": "editor",
          "row": Number(args.uiParams.winRow),
          "col": Number(args.uiParams.winCol),
          "width": Number(args.uiParams.winWidth),
          "height": winHeight,
          "border": args.uiParams.floatingBorder,
        });

        if (args.uiParams.highlights?.floating) {
          await fn.setwinvar(
            args.denops,
            await fn.bufwinnr(args.denops, bufnr),
            "&winhighlight",
            args.uiParams.highlights.floating,
          );
        }
        await fn.setwinvar(
          args.denops,
          await fn.bufwinnr(args.denops, bufnr),
          "&statusline",
          currentStatusline,
        );
      } else if (args.uiParams.split == "no") {
        await args.denops.cmd(`silent keepalt buffer ${bufnr}`);
      } else {
        await args.denops.call(
          "ddu#util#print_error",
          `Invalid split param: ${args.uiParams.split}`,
        );
        return;
      }
      await batch(args.denops, async (denops) => {
        await denops.call("ddu#ui#ff#_reset_auto_action");
        const autoAction = args.uiParams.autoAction;
        if ("name" in autoAction) {
          if (!("params" in autoAction)) {
            autoAction.params = {};
          }
          await denops.call(
            "ddu#ui#ff#_set_auto_action",
            autoAction,
          );
        }
      });
    } else if (args.uiParams.autoResize) {
      await fn.win_execute(
        args.denops,
        winid,
        `resize ${winHeight} | normal! zb`,
      );
      if ((await fn.bufwinid(args.denops, this.filterBufnr)) >= 0) {
        // Redraw floating window
        await args.denops.call(
          "ddu#ui#ff#filter#_floating",
          this.filterBufnr,
          winid,
          args.uiParams,
        );
      }
    }

    // NOTE: buffers may be restored
    if (!this.buffers[args.options.name] || winid < 0) {
      await this.initOptions(args.denops, args.options, args.uiParams, bufnr);
    }

    const augroupName = `${await op.filetype.getLocal(
      args.denops,
    )}-${args.options.name}`;
    await args.denops.cmd(`augroup ${augroupName}`);
    await args.denops.cmd(`autocmd! ${augroupName}`);

    await this.setStatusline(
      args.denops,
      args.context,
      args.options,
      args.uiParams,
      bufnr,
      hasNvim,
      floating,
      augroupName,
    );

    // Update main buffer
    const displaySourceName = args.uiParams.displaySourceName;
    const promptPrefix = args.uiParams.prompt == "" ? "" : " ".repeat(
      1 + (await fn.strwidth(args.denops, args.uiParams.prompt) as number),
    );
    const getSourceName = (sourceName: string) => {
      if (displaySourceName == "long") {
        return sourceName + " ";
      }
      if (displaySourceName == "short") {
        return sourceName.match(/[^a-zA-Z]/)
          ? sourceName.replaceAll(/([a-zA-Z])[a-zA-Z]+/g, "$1") + " "
          : sourceName.slice(0, 2) + " ";
      }
      return "";
    };
    const cursorPos = args.uiParams.cursorPos >= 0 && this.refreshed
      ? args.uiParams.cursorPos
      : 0;
    const refreshed = args.uiParams.cursorPos >= 0 || (this.refreshed &&
        (this.prevLength > 0 && this.items.length < this.prevLength) ||
      (args.uiParams.reversed && this.items.length != this.prevLength));

    // Update main buffer
    try {
      await args.denops.call(
        "ddu#ui#ff#_update_buffer",
        args.uiParams,
        bufnr,
        this.items.map(
          (c) =>
            promptPrefix + `${getSourceName(c.__sourceName)}` +
            (c.display ?? c.word) + (
              (c.action as ActionData)?.isDirectory &&
                !(c.display ?? c.word).endsWith("/")
                ? "/"
                : ""
            ),
        ),
        refreshed,
        cursorPos,
      );
    } catch (e) {
      await errorException(
        args.denops,
        e,
        "[ddu-ui-ff] update buffer failed",
      );
      return;
    }

    this.viewItems = Array.from(this.items);
    if (args.uiParams.reversed) {
      this.viewItems = this.viewItems.reverse();
    }

    await args.denops.call(
      "ddu#ui#ff#_highlight_items",
      args.uiParams,
      bufnr,
      this.items.length,
      this.items.map((c, i) => {
        return {
          highlights: c.highlights ?? [],
          row: i + 1,
          prefix: promptPrefix + `${getSourceName(c.__sourceName)}`,
        };
      }).filter((c) => c.highlights),
      [...this.selectedItems],
    );

    // Save cursor when cursor moved
    await args.denops.cmd(
      `autocmd ${augroupName} CursorMoved <buffer>` +
        " call ddu#ui#ff#_save_cursor()",
    );

    const saveCursor = await fn.getbufvar(
      args.denops,
      bufnr,
      "ddu_ui_ff_save_cursor",
      { pos: [], text: "" },
    ) as SaveCursor;
    let currentText = "";
    if (saveCursor.pos.length != 0) {
      const buflines = await fn.getbufline(
        args.denops,
        bufnr,
        saveCursor.pos[1],
      );
      if (buflines.length != 0) {
        currentText = buflines[0];
      }
    }
    if (
      saveCursor.pos.length != 0 && this.items.length != 0 &&
      currentText == saveCursor.text
    ) {
      await args.denops.call(
        "ddu#ui#ff#_cursor",
        saveCursor.pos[1],
        saveCursor.pos[2],
      );
    }

    if (this.filterBufnr < 0 || winid < 0) {
      if (args.uiParams.startFilter) {
        this.filterBufnr = await args.denops.call(
          "ddu#ui#ff#filter#_open",
          args.options.name,
          args.context.input,
          this.filterBufnr,
          args.uiParams,
        ) as number;
      } else {
        await args.denops.cmd("stopinsert");
      }
    }

    this.buffers[args.options.name] = bufnr;

    this.refreshed = false;
  }

  async quit(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiParams: Params;
  }): Promise<void> {
    await this.previewUi.close(args.denops);
    await this.closeFilterWindow(args.denops);

    // Move to the UI window.
    const bufnr = this.buffers[args.options.name];
    await fn.win_gotoid(
      args.denops,
      await fn.bufwinid(args.denops, bufnr),
    );

    await this.closeFilterWindow(args.denops);

    if (
      args.uiParams.split == "no" || (await fn.winnr(args.denops, "$")) == 1
    ) {
      await args.denops.cmd(
        args.context.bufNr == this.buffers[args.options.name]
          ? "enew"
          : `buffer ${args.context.bufNr}`,
      );
    } else {
      await args.denops.cmd("silent! close!");
      await fn.win_gotoid(args.denops, args.context.winId);
    }

    // Restore options
    const saveTitle = await vars.g.get(
      args.denops,
      "ddu#ui#ff#_save_title",
      "",
    );
    if (saveTitle != "") {
      args.denops.call(
        "nvim_set_option",
        "titlestring",
        saveTitle,
      );
    }

    // Restore mode
    if (this.saveMode == "i") {
      if (this.checkEnd) {
        await fn.feedkeys(args.denops, "A", "n");
      } else {
        await args.denops.cmd("startinsert");
      }
    } else {
      await args.denops.cmd("stopinsert");
    }

    // Close preview window
    await args.denops.cmd("pclose!");

    await args.denops.call("ddu#event", args.options.name, "close");
  }

  // deno-lint-ignore require-await
  async expandItem(args: {
    uiParams: Params;
    parent: DduItem;
    children: DduItem[];
  }) {
    // Search index.
    const index = this.items.findIndex(
      (item: DduItem) =>
        (item.action as ActionData).path ==
          (args.parent.action as ActionData).path &&
        item.__sourceIndex == args.parent.__sourceIndex,
    );

    const insertItems = args.children;

    if (index >= 0) {
      this.items = this.items.slice(0, index + 1).concat(insertItems).concat(
        this.items.slice(index + 1),
      );
      this.items[index] = args.parent;
      const path = (args.parent.action as ActionData).path ?? args.parent.word;
      this.expandedPaths.add(path);
    } else {
      this.items = this.items.concat(insertItems);
    }

    this.selectedItems.clear();
  }

  // deno-lint-ignore require-await
  async collapseItem(args: {
    item: DduItem;
  }) {
    // Search index.
    const startIndex = this.items.findIndex(
      (item: DduItem) =>
        (item.action as ActionData).path ==
          (args.item.action as ActionData).path &&
        item.__sourceIndex == args.item.__sourceIndex,
    );
    if (startIndex < 0) {
      return;
    }

    const endIndex = startIndex + this.items.slice(startIndex + 1).findIndex(
      (item: DduItem) => item.__level <= args.item.__level,
    );

    // Remove from expandedPaths
    for (const item of this.items.slice(startIndex + 1, endIndex)) {
      const path = (item.action as ActionData).path ?? item.word;
      this.expandedPaths.delete(path);
    }

    if (endIndex < 0) {
      this.items = this.items.slice(0, startIndex + 1);
    } else {
      this.items = this.items.slice(0, startIndex + 1).concat(
        this.items.slice(endIndex + 1),
      );
    }

    this.items[startIndex] = args.item;
    const path = (args.item.action as ActionData).path ?? args.item.word;
    this.expandedPaths.delete(path);

    this.selectedItems.clear();
  }

  private async getItem(
    denops: Denops,
  ): Promise<DduItem | null> {
    const idx = await this.getIndex(denops);
    return idx >= 0 ? this.items[idx] : null;
  }

  private async getItems(denops: Denops): Promise<DduItem[]> {
    let items: DduItem[];
    if (this.selectedItems.size == 0) {
      const item = await this.getItem(denops);
      if (!item) {
        return [];
      }

      items = [item];
    } else {
      items = [...this.selectedItems].map((i) => this.items[i]);
    }

    return items.filter((item) => item);
  }

  private async setStatusline(
    denops: Denops,
    context: Context,
    options: DduOptions,
    uiParams: Params,
    bufnr: number,
    hasNvim: boolean,
    floating: boolean,
    augroupName: string,
  ): Promise<void> {
    const statusState = {
      done: context.done,
      input: context.input,
      name: options.name,
      maxItems: context.maxItems,
    };
    await fn.setwinvar(
      denops,
      await fn.bufwinnr(denops, bufnr),
      "ddu_ui_ff_status",
      statusState,
    );

    if (!uiParams.statusline) {
      return;
    }

    const header =
      `[ddu-${options.name}] ${this.items.length}/${context.maxItems}`;
    const linenr = "printf('%'.(len(line('$'))+2).'d/%d',line('.'),line('$'))";
    const async = `${context.done ? "" : "[async]"}`;
    const laststatus = await op.laststatus.get(denops);

    if (hasNvim && (floating || laststatus == 0)) {
      if ((await vars.g.get(denops, "ddu#ui#ff#_save_title", "")) == "") {
        const saveTitle = await denops.call(
          "nvim_get_option",
          "titlestring",
        ) as string;
        await vars.g.set(denops, "ddu#ui#ff#_save_title", saveTitle);
      }

      if (await fn.exists(denops, "##WinClosed")) {
        await denops.cmd(
          `autocmd ${augroupName} WinClosed,BufLeave <buffer>` +
            " let &titlestring=g:ddu#ui#ff#_save_title",
        );
      }

      const titleString = header + " %{" + linenr + "}%*" + async;
      await vars.b.set(denops, "ddu_ui_ff_title", titleString);

      await denops.call(
        "nvim_set_option",
        "titlestring",
        titleString,
      );
      await denops.cmd(
        `autocmd ${augroupName} WinEnter,BufEnter <buffer>` +
          " let &titlestring = " +
          "getbufvar(str2nr(expand('<abuf>')), 'ddu_ui_ff_title')",
      );
    } else {
      await fn.setwinvar(
        denops,
        await fn.bufwinnr(denops, bufnr),
        "&statusline",
        header + " %#LineNR#%{" + linenr + "}%*" + async,
      );
    }
  }

  private async closeFilterWindow(denops: Denops): Promise<void> {
    if (this.filterBufnr > 0) {
      const filterWinNr = await fn.bufwinnr(denops, this.filterBufnr);
      if (filterWinNr > 0) {
        await denops.cmd(`silent! close! ${filterWinNr}`);
      }
    }
  }

  private async collapseItemAction(denops: Denops, options: DduOptions) {
    const index = await this.getIndex(denops);
    if (index < 0) {
      return ActionFlags.None;
    }

    const closeItem = this.items[index];

    if (!(closeItem.action as ActionData).isDirectory) {
      return ActionFlags.None;
    }

    await denops.call(
      "ddu#redraw_tree",
      options.name,
      "collapse",
      [{ item: closeItem }],
    );

    return ActionFlags.None;
  }

  actions: UiActions<Params> = {
    chooseAction: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
    }) => {
      await this.closeFilterWindow(args.denops);

      const items = await this.getItems(args.denops);
      if (items.length == 0) {
        return ActionFlags.None;
      }

      const actions = await args.denops.call(
        "ddu#get_item_actions",
        args.options.name,
        items,
      );

      await args.denops.call("ddu#start", {
        name: args.options.name,
        push: true,
        sources: [
          {
            name: "action",
            options: {},
            params: {
              actions: actions,
              name: args.options.name,
              items: items,
            },
          },
        ],
      });

      return ActionFlags.None;
    },
    // deno-lint-ignore require-await
    clearSelectAllItems: async (_: {
      denops: Denops;
    }) => {
      this.selectedItems.clear();
      return ActionFlags.Redraw;
    },
    expandItem: async (args: {
      denops: Denops;
      options: DduOptions;
      actionParams: unknown;
    }) => {
      const idx = await this.getIndex(args.denops);
      if (idx < 0) {
        return ActionFlags.None;
      }

      const item = this.items[idx];
      const params = args.actionParams as ExpandItemParams;

      if (item.__expanded) {
        if (params.mode == "toggle") {
          return await this.collapseItemAction(args.denops, args.options);
        }
        return ActionFlags.None;
      }

      await args.denops.call(
        "ddu#redraw_tree",
        args.options.name,
        "expand",
        [{ item, maxLevel: params.maxLevel ?? 0 }],
      );

      return ActionFlags.None;
    },
    itemAction: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
    }) => {
      const params = args.actionParams as DoActionParams;
      const items = params.items ?? await this.getItems(args.denops);
      if (items.length == 0) {
        return ActionFlags.None;
      }

      await args.denops.call(
        "ddu#item_action",
        args.options.name,
        params.name ?? "default",
        items,
        params.params ?? {},
      );

      return ActionFlags.None;
    },
    openFilterWindow: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
    }) => {
      await this.setDefaultParams(args.denops, args.uiParams);

      this.filterBufnr = await args.denops.call(
        "ddu#ui#ff#filter#_open",
        args.options.name,
        args.context.input,
        this.filterBufnr,
        args.uiParams,
      ) as number;

      return ActionFlags.None;
    },
    preview: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
    }) => {
      const idx = await this.getIndex(args.denops);
      if (idx < 0) {
        return ActionFlags.None;
      }

      const item = this.items[idx];
      if (!item) {
        return ActionFlags.None;
      }

      return this.previewUi.previewContents(
        args.denops,
        args.context,
        args.options,
        args.uiParams,
        args.actionParams,
        this.buffers[args.options.name],
        item,
      );
    },
    previewPath: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
    }) => {
      const idx = await this.getIndex(args.denops);
      if (idx < 0) {
        return ActionFlags.None;
      }

      const item = this.items[idx];
      if (!item) {
        return ActionFlags.None;
      }

      await args.denops.call("ddu#ui#ff#_echo", item.display ?? item.word);

      return ActionFlags.Persist;
    },
    quit: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
    }) => {
      await this.quit({
        denops: args.denops,
        context: args.context,
        options: args.options,
        uiParams: args.uiParams,
      });
      await args.denops.call("ddu#pop", args.options.name);

      return ActionFlags.None;
    },
    // deno-lint-ignore require-await
    refreshItems: async (_: {
      denops: Denops;
    }) => {
      return ActionFlags.RefreshItems;
    },
    // deno-lint-ignore require-await
    toggleAllItems: async (_: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
    }) => {
      if (this.items.length == 0) {
        return ActionFlags.None;
      }

      this.items.forEach((_, idx) => {
        if (this.selectedItems.has(idx)) {
          this.selectedItems.delete(idx);
        } else {
          this.selectedItems.add(idx);
        }
      });

      return ActionFlags.Redraw;
    },
    toggleSelectItem: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
    }) => {
      const idx = await this.getIndex(args.denops);
      if (idx < 0) {
        return ActionFlags.None;
      }

      if (this.selectedItems.has(idx)) {
        this.selectedItems.delete(idx);
      } else {
        this.selectedItems.add(idx);
      }

      return ActionFlags.Redraw;
    },
    updateOptions: async (args: {
      denops: Denops;
      options: DduOptions;
      actionParams: unknown;
    }) => {
      await args.denops.call("ddu#redraw", args.options.name, {
        updateOptions: args.actionParams,
      });
      return ActionFlags.None;
    },
  };

  params(): Params {
    return {
      autoAction: {},
      autoResize: false,
      cursorPos: -1,
      displaySourceName: "no",
      filterFloatingPosition: "bottom",
      filterSplitDirection: "botright",
      filterUpdateTime: 0,
      floatingBorder: "none",
      highlights: {},
      ignoreEmpty: false,
      previewCol: 0,
      previewFloating: false,
      previewHeight: 10,
      previewRow: 0,
      previewVertical: false,
      previewWidth: 40,
      previewFloatingBorder: "none",
      previewFloatingZindex: 50,
      prompt: "",
      reversed: false,
      split: "horizontal",
      splitDirection: "botright",
      startFilter: false,
      statusline: true,
      winCol: 0,
      winHeight: 20,
      winRow: 0,
      winWidth: 0,
    };
  }

  private async initBuffer(
    denops: Denops,
    bufferName: string,
  ): Promise<number> {
    const bufnr = await fn.bufadd(denops, bufferName);
    await fn.bufload(denops, bufnr);

    return bufnr;
  }

  private async initOptions(
    denops: Denops,
    options: DduOptions,
    uiParams: Params,
    bufnr: number,
  ): Promise<void> {
    const winid = await fn.bufwinid(denops, bufnr);

    await batch(denops, async (denops: Denops) => {
      await fn.setbufvar(denops, bufnr, "ddu_ui_name", options.name);

      // Set options
      await fn.setwinvar(denops, winid, "&list", 0);
      await fn.setwinvar(denops, winid, "&colorcolumn", "");
      await fn.setwinvar(denops, winid, "&cursorline", 1);
      await fn.setwinvar(denops, winid, "&foldcolumn", 0);
      await fn.setwinvar(denops, winid, "&foldenable", 0);
      await fn.setwinvar(denops, winid, "&number", 0);
      await fn.setwinvar(denops, winid, "&relativenumber", 0);
      await fn.setwinvar(denops, winid, "&signcolumn", "no");
      await fn.setwinvar(denops, winid, "&spell", 0);
      await fn.setwinvar(denops, winid, "&wrap", 0);
      await fn.setwinvar(denops, winid, "&signcolumn", "no");

      await fn.setbufvar(denops, bufnr, "&bufhidden", "unload");
      await fn.setbufvar(denops, bufnr, "&buftype", "nofile");
      await fn.setbufvar(denops, bufnr, "&filetype", "ddu-ff");
      await fn.setbufvar(denops, bufnr, "&swapfile", 0);

      if (uiParams.split == "horizontal") {
        await fn.setbufvar(denops, bufnr, "&winfixheight", 1);
      } else if (uiParams.split == "vertical") {
        await fn.setbufvar(denops, bufnr, "&winfixwidth", 1);
      }
    });
  }

  private async setDefaultParams(denops: Denops, uiParams: Params) {
    if (uiParams.winRow == 0) {
      uiParams.winRow = Math.trunc(
        (await denops.call("eval", "&lines") as number) / 2 - 10,
      );
    }
    if (uiParams.winCol == 0) {
      uiParams.winCol = Math.trunc(
        (await op.columns.getGlobal(denops)) / 4,
      );
    }
    if (uiParams.winWidth == 0) {
      uiParams.winWidth = Math.trunc((await op.columns.getGlobal(denops)) / 2);
    }
  }

  private async getIndex(
    denops: Denops,
  ): Promise<number> {
    const ft = await op.filetype.getLocal(denops);
    const parentId = await vars.g.get(
      denops,
      "ddu#ui#ff#_filter_parent_winid",
      -1,
    );

    const idx = ft == "ddu-ff"
      ? (await fn.line(denops, ".")) - 1
      : (await denops.call("line", ".", parentId) as number) - 1;
    const viewItem = this.viewItems[idx];
    return this.items.findIndex(
      (item: DduItem) => item == viewItem,
    );
  }

  private expandPath(
    path: string,
  ): ExpandItem | undefined {
    let parent = path;
    let item = undefined;
    let maxLevel = 0;
    while (1) {
      item = this.items.find(
        (item) => parent == (item?.action as ActionData).path ?? item.word,
      );

      if (parent == dirname(parent) || item) {
        break;
      }

      parent = dirname(parent);
      maxLevel++;
    }
    if (item && !item.__expanded) {
      return { item, search: path, maxLevel };
    }
  }
}

async function errorException(denops: Denops, e: unknown, message: string) {
  await denops.call(
    "ddu#util#print_error",
    message,
  );
  if (e instanceof Error) {
    await denops.call(
      "ddu#util#print_error",
      e.message,
    );
    if (e.stack) {
      await denops.call(
        "ddu#util#print_error",
        e.stack,
      );
    }
  }
}
