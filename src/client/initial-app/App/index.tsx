import type { FileDropEvent } from 'file-drop-element';
import type SnackBarElement from 'shared/custom-els/snack-bar';
import type { SnackOptions } from 'shared/custom-els/snack-bar';

import { h, Component } from 'preact';

import { linkRef } from 'shared/prerendered-app/util';
import * as style from './style.css';
import 'add-css:./style.css';
import 'file-drop-element';
import 'shared/custom-els/snack-bar';
import Intro from 'shared/prerendered-app/Intro';
import 'shared/custom-els/loading-spinner';
import Tool, { ToolMode } from 'client/lazy-app/Tool';

const swBridgePromise = import('client/lazy-app/sw-bridge');

function back() {
  window.history.back();
}

interface Props {}

interface State {
  awaitingShareTarget: boolean;
  activeTool: ToolMode;
  files: File[];
  isEditorOpen: Boolean;
  Tool?: typeof import('client/lazy-app/Tool').default;
}

function modeFromQuery(): ToolMode {
  try {
    const t = new URL(location.href).searchParams.get('tool');
    if (t === 'watermark') return 'watermark';
    if (t === 'resize') return 'resize';
    return 'compress';
  } catch {
    return 'compress';
  }
}

/** Map any legacy route to (editor open?, mode). */
function routeInfo(): { open: boolean; mode: ToolMode } {
  const p = location.pathname;
  if (p === '/watermark') return { open: true, mode: 'watermark' };
  if (p === '/batch') return { open: true, mode: 'compress' };
  if (p === '/editor') return { open: true, mode: modeFromQuery() };
  return { open: false, mode: modeFromQuery() };
}

export default class App extends Component<Props, State> {
  state: State = {
    awaitingShareTarget: new URL(location.href).searchParams.has(
      'share-target',
    ),
    activeTool: routeInfo().mode,
    files: [],
    isEditorOpen: routeInfo().open,
    Tool: undefined,
  };

  snackbar?: SnackBarElement;

  constructor() {
    super();

    import('client/lazy-app/Tool')
      .then((module) => {
        this.setState({ Tool: module.default });
      })
      .catch(() => {
        this.showSnack('Failed to load app');
      });

    swBridgePromise.then(async ({ offliner, getSharedImage }) => {
      offliner(this.showSnack);
      if (!this.state.awaitingShareTarget) return;
      const file = await getSharedImage();
      history.replaceState('', '', '/');
      this.openEditor();
      this.setState({ files: [file], awaitingShareTarget: false });
    });

    document.body.addEventListener('gesturestart', (event: any) => {
      event.preventDefault();
    });

    window.addEventListener('popstate', this.onPopState);
  }

  private onFileDrop = ({ files }: FileDropEvent) => {
    if (!files || files.length === 0) return;
    this.handleFiles(Array.from(files));
  };

  private handleFiles = (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    this.openEditor();
    this.setState({ files: imgs });
  };

  private setActiveTool = (tool: ToolMode) => {
    this.setState({ activeTool: tool });
  };

  private showSnack = (
    message: string,
    options: SnackOptions = {},
  ): Promise<string> => {
    if (!this.snackbar) throw Error('Snackbar missing');
    return this.snackbar.showSnackbar(message, options);
  };

  private onPopState = () => {
    const info = routeInfo();
    this.setState({ isEditorOpen: info.open, activeTool: info.mode });
  };

  private openEditor = (tool?: ToolMode) => {
    const url = new URL(location.href);
    url.pathname = '/editor';
    if (tool) url.searchParams.set('tool', tool);
    else url.searchParams.delete('tool');
    history.pushState(null, '', url.href);
    this.setState({ isEditorOpen: true });
  };

  // Used by the editor's back button / nav links.
  private goHome = () => {
    history.pushState(null, '', '/');
    this.setState({ isEditorOpen: false });
  };

  render(
    {}: Props,
    { activeTool, files, isEditorOpen, Tool, awaitingShareTarget }: State,
  ) {
    const showSpinner = awaitingShareTarget || (isEditorOpen && !Tool);

    return (
      <div class={style.app}>
        <file-drop onfiledrop={this.onFileDrop} class={style.drop}>
          {showSpinner ? (
            <loading-spinner class={style.appLoader} />
          ) : isEditorOpen ? (
            Tool && (
              <Tool
                files={files}
                mode={activeTool}
                onModeChange={this.setActiveTool}
                onBack={this.goHome}
                showSnack={this.showSnack}
              />
            )
          ) : (
            <Intro
              tool={activeTool}
              onToolChange={this.setActiveTool}
              onOpenTool={(t) => this.openEditor(t)}
              onFiles={this.handleFiles}
              showSnack={this.showSnack}
            />
          )}
          <snack-bar ref={linkRef(this, 'snackbar')} />
        </file-drop>
      </div>
    );
  }
}
