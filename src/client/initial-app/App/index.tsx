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

const ROUTE_EDITOR = '/editor';
const ROUTE_BATCH = '/batch';
const ROUTE_WATERMARK = '/watermark';

type Tool = 'compress' | 'watermark';

const compressPromise = import('client/lazy-app/Compress');
const batchPromise = import('client/lazy-app/Batch');
const watermarkPromise = import('client/lazy-app/Watermark');
const swBridgePromise = import('client/lazy-app/sw-bridge');

function back() {
  window.history.back();
}

interface Props {}

interface State {
  awaitingShareTarget: boolean;
  activeTool: Tool;
  file?: File;
  files?: File[];
  isEditorOpen: Boolean;
  isBatchOpen: Boolean;
  isWatermarkOpen: Boolean;
  Compress?: typeof import('client/lazy-app/Compress').default;
  Batch?: typeof import('client/lazy-app/Batch').default;
  Watermark?: typeof import('client/lazy-app/Watermark').default;
}

export default class App extends Component<Props, State> {
  state: State = {
    awaitingShareTarget: new URL(location.href).searchParams.has(
      'share-target',
    ),
    activeTool: 'compress',
    isEditorOpen: false,
    isBatchOpen: false,
    isWatermarkOpen: false,
    file: undefined,
    files: undefined,
    Compress: undefined,
    Batch: undefined,
    Watermark: undefined,
  };

  snackbar?: SnackBarElement;

  constructor() {
    super();

    compressPromise
      .then((module) => {
        this.setState({ Compress: module.default });
      })
      .catch(() => {
        this.showSnack('Failed to load app');
      });

    batchPromise
      .then((module) => {
        this.setState({ Batch: module.default });
      })
      .catch(() => {
        this.showSnack('Failed to load batch tool');
      });

    watermarkPromise
      .then((module) => {
        this.setState({ Watermark: module.default });
      })
      .catch(() => {
        this.showSnack('Failed to load watermark tool');
      });

    swBridgePromise.then(async ({ offliner, getSharedImage }) => {
      offliner(this.showSnack);
      if (!this.state.awaitingShareTarget) return;
      const file = await getSharedImage();
      // Remove the ?share-target from the URL
      history.replaceState('', '', '/');
      this.openEditor();
      this.setState({ file, awaitingShareTarget: false });
    });

    // Since iOS 10, Apple tries to prevent disabling pinch-zoom. This is great in theory, but
    // really breaks things on Squoosh, as you can easily end up zooming the UI when you mean to
    // zoom the image. Once you've done this, it's really difficult to undo. Anyway, this seems to
    // prevent it.
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
    if (files.length === 0) return;
    if (this.state.activeTool === 'watermark') {
      this.openWatermark();
      this.setState({ files, file: undefined });
      return;
    }
    if (files.length === 1) {
      this.openEditor();
      this.setState({ file: files[0], files: undefined });
    } else {
      this.openBatch();
      this.setState({ files, file: undefined });
    }
  };

  private onIntroPickFile = (file: File) => {
    this.openEditor();
    this.setState({ file });
  };

  private setActiveTool = (tool: Tool) => {
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
    this.setState({
      isEditorOpen: location.pathname === ROUTE_EDITOR,
      isBatchOpen: location.pathname === ROUTE_BATCH,
      isWatermarkOpen: location.pathname === ROUTE_WATERMARK,
    });
  };

  private openEditor = () => {
    if (this.state.isEditorOpen) return;
    // Change path, but preserve query string.
    const editorURL = new URL(location.href);
    editorURL.pathname = ROUTE_EDITOR;
    history.pushState(null, '', editorURL.href);
    this.setState({
      isEditorOpen: true,
      isBatchOpen: false,
      isWatermarkOpen: false,
    });
  };

  private openBatch = () => {
    if (this.state.isBatchOpen) return;
    const batchURL = new URL(location.href);
    batchURL.pathname = ROUTE_BATCH;
    history.pushState(null, '', batchURL.href);
    this.setState({
      isBatchOpen: true,
      isEditorOpen: false,
      isWatermarkOpen: false,
    });
  };

  private openWatermark = () => {
    if (this.state.isWatermarkOpen) return;
    const wmURL = new URL(location.href);
    wmURL.pathname = ROUTE_WATERMARK;
    history.pushState(null, '', wmURL.href);
    this.setState({
      isWatermarkOpen: true,
      isEditorOpen: false,
      isBatchOpen: false,
    });
  };

  render(
    {}: Props,
    {
      activeTool,
      file,
      files,
      isEditorOpen,
      isBatchOpen,
      isWatermarkOpen,
      Compress,
      Batch,
      Watermark,
      awaitingShareTarget,
    }: State,
  ) {
    const showSpinner =
      awaitingShareTarget ||
      (isEditorOpen && !Compress) ||
      (isBatchOpen && !Batch) ||
      (isWatermarkOpen && !Watermark);

    return (
      <div class={style.app}>
        <file-drop onfiledrop={this.onFileDrop} class={style.drop}>
          {showSpinner ? (
            <loading-spinner class={style.appLoader} />
          ) : isBatchOpen && files && files.length > 0 ? (
            Batch && (
              <Batch
                files={files}
                showSnack={this.showSnack}
                onBack={back}
                onAddFiles={this.handleFiles}
              />
            )
          ) : isWatermarkOpen && files && files.length > 0 ? (
            Watermark && (
              <Watermark
                files={files}
                showSnack={this.showSnack}
                onBack={back}
                onAddFiles={this.handleFiles}
              />
            )
          ) : isEditorOpen ? (
            Compress && (
              <Compress file={file!} showSnack={this.showSnack} onBack={back} />
            )
          ) : (
            <Intro
              tool={activeTool}
              onToolChange={this.setActiveTool}
              onFile={this.onIntroPickFile}
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
