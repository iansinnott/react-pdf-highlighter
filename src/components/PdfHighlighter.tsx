import React, { PointerEventHandler, PureComponent } from "react";
import ReactDom from "react-dom/client";
import { debounce } from "throttle-debounce";

import {
  EventBus,
  PDFViewer,
  PDFLinkService,
} from "pdfjs-dist/legacy/web/pdf_viewer";

import "pdfjs-dist/web/pdf_viewer.css";
import "../style/pdf_viewer.css";

import "../style/PdfHighlighter.css";

import getBoundingRect from "../lib/get-bounding-rect";
import getClientRects from "../lib/get-client-rects";
import getAreaAsPng from "../lib/get-area-as-png";

import {
  asElement,
  getPagesFromRange,
  getPageFromElement,
  getWindow,
  findOrCreateContainerLayer,
  isHTMLElement,
} from "../lib/pdfjs-dom";

import TipContainer from "./TipContainer";
import MouseSelection from "./MouseSelection";

import { scaledToViewport, viewportToScaled } from "../lib/coordinates";

import type {
  Position,
  ScaledPosition,
  IHighlight,
  Scaled,
  LTWH,
  LTWHP,
} from "../types";
import type { PDFDocumentProxy } from "pdfjs-dist";

type T_ViewportHighlight<T_HT> = { position: Position } & T_HT;

interface State<T_HT> {
  ghostHighlight: {
    position: ScaledPosition;
    content?: { text?: string; image?: string };
  } | null;
  isCollapsed: boolean;
  range: Range | null;
  tip: {
    highlight: T_ViewportHighlight<T_HT>;
    callback: (highlight: T_ViewportHighlight<T_HT>) => JSX.Element;
  } | null;
  tipPosition: Position | null;
  tipChildren: JSX.Element | null;
  isAreaSelectionInProgress: boolean;
  scrolledToHighlightId: string;
}

interface Props<T_HT> {
  highlightTransform: (
    highlight: T_ViewportHighlight<T_HT>,
    index: number,
    setTip: (
      highlight: T_ViewportHighlight<T_HT>,
      callback: (highlight: T_ViewportHighlight<T_HT>) => JSX.Element
    ) => void,
    hideTip: () => void,
    viewportToScaled: (rect: LTWHP) => Scaled,
    screenshot: (position: LTWH) => string,
    isScrolledTo: boolean
  ) => JSX.Element;
  highlights: Array<T_HT>;
  onScrollChange: () => void;
  scrollRef: (scrollTo: (highlight: IHighlight) => void) => void;
  pdfDocument: PDFDocumentProxy;

  /**
   * Should be one of the predefined values or a numeric string, such as "1.2"
   */
  pdfScaleValue: "auto" | "page-width" | "page-fit" | string;

  onSelectionFinished: (
    position: ScaledPosition,
    content: { text?: string; image?: string },
    hideTipAndSelection: () => void,
    transformSelection: () => void
  ) => JSX.Element | null;
  enableAreaSelection: (event: MouseEvent) => boolean;
  resizeDebounceMs: number;
  selectionDebounceMs: number;
}

const EMPTY_ID = "empty-id";

export class PdfHighlighter<T_HT extends IHighlight> extends PureComponent<
  Props<T_HT>,
  State<T_HT>
> {
  static defaultProps = {
    pdfScaleValue: "auto",
    resizeDebounceMs: 300,
    selectionDebounceMs: 120,
  };

  state: State<T_HT> = {
    ghostHighlight: null,
    isCollapsed: true,
    range: null,
    scrolledToHighlightId: EMPTY_ID,
    isAreaSelectionInProgress: false,
    tip: null,
    tipPosition: null,
    tipChildren: null,
  };

  eventBus = new EventBus();
  linkService = new PDFLinkService({
    eventBus: this.eventBus,
    externalLinkTarget: 2,
  });

  viewer!: PDFViewer;

  resizeObserver: ResizeObserver | null = null;
  containerNode?: HTMLDivElement | null = null;
  unsubscribe = () => {};

  constructor(props: Props<T_HT>) {
    super(props);

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.debouncedScaleValue);
    }

    this.validateProps();
  }

  validateProps() {
    if (this.props.resizeDebounceMs < 0) {
      console.warn(
        "[PdfHighlighter] WARNING You passed a negative value for resizeDebounceMs"
      );
    }
  }

  componentDidMount() {
    this.init();
  }

  attachRef = (ref: HTMLDivElement | null) => {
    const { eventBus, resizeObserver: observer } = this;
    this.containerNode = ref;
    this.unsubscribe();

    if (ref) {
      const { ownerDocument: doc } = ref;
      eventBus.on("textlayerrendered", this.onTextLayerRendered);
      eventBus.on("pagesinit", this.onDocumentReady);
      doc.addEventListener("selectionchange", this.onSelectionChange);
      doc.addEventListener("keydown", this.handleKeyDown);
      doc.defaultView?.addEventListener("resize", this.debouncedScaleValue);
      if (observer) observer.observe(ref);

      this.unsubscribe = () => {
        eventBus.off("pagesinit", this.onDocumentReady);
        eventBus.off("textlayerrendered", this.onTextLayerRendered);
        doc.removeEventListener("selectionchange", this.onSelectionChange);
        doc.removeEventListener("keydown", this.handleKeyDown);
        doc.defaultView?.removeEventListener(
          "resize",
          this.debouncedScaleValue
        );
        if (observer) observer.disconnect();
      };
    }
  };

  componentDidUpdate(prevProps: Props<T_HT>) {
    if (prevProps.pdfDocument !== this.props.pdfDocument) {
      this.init();
      return;
    }
    if (prevProps.highlights !== this.props.highlights) {
      this.renderHighlights(this.props);
    }
  }

  init() {
    const { pdfDocument } = this.props;

    this.viewer =
      this.viewer ||
      new PDFViewer({
        container: this.containerNode!,
        eventBus: this.eventBus,
        // enhanceTextSelection: true, // deprecated. https://github.com/mozilla/pdf.js/issues/9943#issuecomment-409369485
        textLayerMode: 2,
        removePageBorders: true,
        linkService: this.linkService,
        renderer: "canvas",
        l10n: null,
      });

    this.linkService.setDocument(pdfDocument);
    this.linkService.setViewer(this.viewer);
    this.viewer.setDocument(pdfDocument);

    // When initializing a new doc discard all previous react root refs
    this.roots = new Map();

    // debug
    (window as any).PdfViewer = this;
  }

  componentWillUnmount() {
    this.unsubscribe();
    // Make sure roots isn't holding on to any refs
    this.roots = new Map();
  }

  roots: Map<any, any> = new Map();

  findOrCreateHighlightLayer(page: number): ReactDom.Root | null {
    const { textLayer } = this.viewer.getPageView(page - 1) || {};

    if (!textLayer) {
      return null;
    }

    const el = findOrCreateContainerLayer(
      textLayer.textLayerDiv,
      "PdfHighlighter__highlight-layer"
    );

    if (this.roots.get(el)) {
      console.debug("[react root nonsense] Hit cached root");
      return this.roots.get(el);
    } else {
      const root = ReactDom.createRoot(el);
      this.roots.set(el, root);
      console.debug(
        "[react root nonsense] Initializing new react root for",
        el
      );
      return root;
    }
  }

  groupHighlightsByPage(highlights: Array<T_HT>): {
    [pageNumber: string]: Array<T_HT>;
  } {
    const { ghostHighlight } = this.state;

    const allHighlights = [...highlights, ghostHighlight].filter(Boolean);

    const pageNumbers = new Set<number>();
    for (const highlight of allHighlights) {
      pageNumbers.add(highlight!.position.pageNumber);
      for (const rect of highlight!.position.rects) {
        if (rect.pageNumber) {
          pageNumbers.add(rect.pageNumber);
        }
      }
    }

    const groupedHighlights = {} as Record<number, any[]>;

    for (const pageNumber of pageNumbers) {
      groupedHighlights[pageNumber] = groupedHighlights[pageNumber] || [];
      for (const highlight of allHighlights) {
        const pageSpecificHighlight = {
          ...highlight,
          position: {
            pageNumber,
            boundingRect: highlight!.position.boundingRect,
            rects: [],
            usePdfCoordinates: highlight!.position.usePdfCoordinates,
          } as ScaledPosition,
        };
        let anyRectsOnPage = false;
        for (const rect of highlight!.position.rects) {
          if (
            pageNumber === (rect.pageNumber || highlight!.position.pageNumber)
          ) {
            pageSpecificHighlight.position.rects.push(rect);
            anyRectsOnPage = true;
          }
        }
        if (anyRectsOnPage || pageNumber === highlight!.position.pageNumber) {
          groupedHighlights[pageNumber].push(pageSpecificHighlight);
        }
      }
    }

    return groupedHighlights;
  }

  showTip(highlight: T_ViewportHighlight<T_HT>, content: JSX.Element) {
    const { isCollapsed, ghostHighlight, isAreaSelectionInProgress } =
      this.state;

    const highlightInProgress = !isCollapsed || ghostHighlight;

    if (highlightInProgress || isAreaSelectionInProgress) {
      return;
    }

    this.setTip(highlight.position, content);
  }

  scaledPositionToViewport({
    pageNumber,
    boundingRect,
    rects,
    usePdfCoordinates,
  }: ScaledPosition): Position {
    const viewport = this.viewer.getPageView(pageNumber - 1).viewport;

    return {
      boundingRect: scaledToViewport(boundingRect, viewport, usePdfCoordinates),
      rects: (rects || []).map((rect) =>
        scaledToViewport(rect, viewport, usePdfCoordinates)
      ),
      pageNumber,
    };
  }

  viewportPositionToScaled({
    pageNumber,
    boundingRect,
    rects,
  }: Position): ScaledPosition {
    const viewport = this.viewer.getPageView(pageNumber - 1).viewport;

    return {
      boundingRect: viewportToScaled(boundingRect, viewport),
      rects: (rects || []).map((rect) => viewportToScaled(rect, viewport)),
      pageNumber,
    };
  }

  screenshot(position: LTWH, pageNumber: number) {
    const canvas = this.viewer.getPageView(pageNumber - 1).canvas;

    return getAreaAsPng(canvas, position);
  }

  renderHighlights(nextProps?: Props<T_HT>) {
    const { highlightTransform, highlights } = nextProps || this.props;

    const { pdfDocument } = this.props;

    const { tip, scrolledToHighlightId } = this.state;

    const highlightsByPage = this.groupHighlightsByPage(highlights);

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
      const highlightLayer = this.findOrCreateHighlightLayer(pageNumber);

      if (highlightLayer) {
        highlightLayer.render(
          <div>
            {(highlightsByPage[String(pageNumber)] || []).map(
              ({ position, id, ...highlight }, index) => {
                // @ts-ignore
                const viewportHighlight: T_ViewportHighlight<T_HT> = {
                  id,
                  position: this.scaledPositionToViewport(position),
                  ...highlight,
                };

                if (tip && tip.highlight.id === String(id)) {
                  this.showTip(tip.highlight, tip.callback(viewportHighlight));
                }

                const isScrolledTo = Boolean(scrolledToHighlightId === id);

                return highlightTransform(
                  viewportHighlight,
                  index,
                  (highlight, callback) => {
                    this.setState({
                      tip: { highlight, callback },
                    });

                    this.showTip(highlight, callback(highlight));
                  },
                  this.hideTipAndSelection,
                  (rect) => {
                    const viewport = this.viewer.getPageView(
                      (rect.pageNumber || pageNumber) - 1
                    ).viewport;

                    return viewportToScaled(rect, viewport);
                  },
                  (boundingRect) => this.screenshot(boundingRect, pageNumber),
                  isScrolledTo
                );
              }
            )}
          </div>
        );
      }
    }
  }

  hideTipAndSelection = () => {
    this.setState({
      tipPosition: null,
      tipChildren: null,
    });

    this.setState({ ghostHighlight: null, tip: null }, () =>
      this.renderHighlights()
    );
  };

  setTip(position: Position, inner: JSX.Element | null) {
    this.setState({
      tipPosition: position,
      tipChildren: inner,
    });
  }

  renderTip = () => {
    const { tipPosition, tipChildren } = this.state;
    if (!tipPosition) return null;

    const { boundingRect, pageNumber } = tipPosition;
    const page = {
      node: this.viewer.getPageView((boundingRect.pageNumber || pageNumber) - 1)
        .div,
      pageNumber: boundingRect.pageNumber || pageNumber,
    };

    const pageBoundingClientRect = page.node.getBoundingClientRect();

    const pageBoundingRect = {
      bottom: pageBoundingClientRect.bottom,
      height: pageBoundingClientRect.height,
      left: pageBoundingClientRect.left,
      right: pageBoundingClientRect.right,
      top: pageBoundingClientRect.top,
      width: pageBoundingClientRect.width,
      x: pageBoundingClientRect.x,
      y: pageBoundingClientRect.y,
      pageNumber: page.pageNumber,
    };

    return (
      <TipContainer
        scrollTop={this.viewer.container.scrollTop}
        pageBoundingRect={pageBoundingRect}
        style={{
          left:
            page.node.offsetLeft + boundingRect.left + boundingRect.width / 2,
          top: boundingRect.top + page.node.offsetTop,
          bottom: boundingRect.top + page.node.offsetTop + boundingRect.height,
        }}
      >
        {tipChildren}
      </TipContainer>
    );
  };

  onTextLayerRendered = () => {
    this.renderHighlights();
  };

  scrollTo = (highlight: IHighlight) => {
    const { pageNumber, boundingRect, usePdfCoordinates } = highlight.position;

    this.viewer.container.removeEventListener("scroll", this.onScroll);

    const pageViewport = this.viewer.getPageView(pageNumber - 1).viewport;

    const scrollMargin = 10;

    this.viewer.scrollPageIntoView({
      pageNumber,
      destArray: [
        null,
        { name: "XYZ" },
        ...pageViewport.convertToPdfPoint(
          0,
          scaledToViewport(boundingRect, pageViewport, usePdfCoordinates).top -
            scrollMargin
        ),
        0,
      ],
    });

    this.setState(
      {
        scrolledToHighlightId: highlight.id,
      },
      () => this.renderHighlights()
    );

    // wait for scrolling to finish
    setTimeout(() => {
      this.viewer.container.addEventListener("scroll", this.onScroll);
    }, 100);
  };

  onDocumentReady = () => {
    const { scrollRef } = this.props;

    this.handleScaleValue();

    scrollRef(this.scrollTo);
  };

  onSelectionChange = () => {
    const container = this.containerNode;
    const selection = getWindow(container).getSelection();

    if (!selection) {
      return;
    }

    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    if (selection.isCollapsed) {
      this.setState({ isCollapsed: true });
      return;
    }

    if (
      !range ||
      !container ||
      !container.contains(range.commonAncestorContainer)
    ) {
      return;
    }

    this.setState({
      isCollapsed: false,
      range,
    });

    this.debouncedAfterSelection();
  };

  onScroll = () => {
    const { onScrollChange } = this.props;

    onScrollChange();

    this.setState(
      {
        scrolledToHighlightId: EMPTY_ID,
      },
      () => this.renderHighlights()
    );

    this.viewer.container.removeEventListener("scroll", this.onScroll);
  };

  onMouseDown: PointerEventHandler = (event) => {
    if (!isHTMLElement(event.target)) {
      return;
    }

    if (asElement(event.target).closest(".PdfHighlighter__tip-container")) {
      return;
    }

    this.hideTipAndSelection();
  };

  handleKeyDown = (event: KeyboardEvent) => {
    if (event.code === "Escape") {
      this.hideTipAndSelection();
    }
  };

  afterSelection = () => {
    const { onSelectionFinished } = this.props;

    const { isCollapsed, range } = this.state;

    if (!range || isCollapsed) {
      return;
    }

    const pages = getPagesFromRange(range);

    if (!pages || pages.length === 0) {
      return;
    }

    const rects = getClientRects(range, pages);

    if (rects.length === 0) {
      return;
    }

    const boundingRect = getBoundingRect(rects);

    const viewportPosition: Position = {
      boundingRect,
      rects,
      pageNumber: pages[0].number,
    };

    const content = {
      text: range.toString(),
    };
    const scaledPosition = this.viewportPositionToScaled(viewportPosition);

    this.setTip(
      viewportPosition,
      onSelectionFinished(
        scaledPosition,
        content,
        () => this.hideTipAndSelection(),
        () =>
          this.setState(
            {
              ghostHighlight: { position: scaledPosition },
            },
            () => this.renderHighlights()
          )
      )
    );
  };

  debouncedAfterSelection: () => void = debounce(
    this.props.selectionDebounceMs,
    this.afterSelection
  );

  toggleTextSelection(flag: boolean) {
    this.viewer.viewer!.classList.toggle(
      "PdfHighlighter--disable-selection",
      flag
    );
  }

  handleScaleValue = () => {
    if (this.viewer) {
      this.viewer.currentScaleValue = this.props.pdfScaleValue; //"page-width";
    }
  };

  debouncedScaleValue: () => void = debounce(
    this.props.resizeDebounceMs,
    this.handleScaleValue
  );

  render() {
    const { onSelectionFinished, enableAreaSelection } = this.props;

    return (
      <div onPointerDown={this.onMouseDown}>
        <div
          ref={this.attachRef}
          className="PdfHighlighter"
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="pdfViewer" />
          {this.renderTip()}
          {typeof enableAreaSelection === "function" ? (
            <MouseSelection
              onDragStart={() => this.toggleTextSelection(true)}
              onDragEnd={() => this.toggleTextSelection(false)}
              onChange={(isVisible) =>
                this.setState({ isAreaSelectionInProgress: isVisible })
              }
              shouldStart={(event) =>
                enableAreaSelection(event) &&
                isHTMLElement(event.target) &&
                Boolean(asElement(event.target).closest(".page"))
              }
              onSelection={(startTarget, boundingRect, resetSelection) => {
                const page = getPageFromElement(startTarget);

                if (!page) {
                  return;
                }

                const pageBoundingRect = {
                  ...boundingRect,
                  top: boundingRect.top - page.node.offsetTop,
                  left: boundingRect.left - page.node.offsetLeft,
                  pageNumber: page.number,
                };

                const viewportPosition = {
                  boundingRect: pageBoundingRect,
                  rects: [],
                  pageNumber: page.number,
                };

                const scaledPosition =
                  this.viewportPositionToScaled(viewportPosition);

                const image = this.screenshot(
                  pageBoundingRect,
                  pageBoundingRect.pageNumber
                );

                this.setTip(
                  viewportPosition,
                  onSelectionFinished(
                    scaledPosition,
                    { image },
                    () => this.hideTipAndSelection(),
                    () =>
                      this.setState(
                        {
                          ghostHighlight: {
                            position: scaledPosition,
                            content: { image },
                          },
                        },
                        () => {
                          resetSelection();
                          this.renderHighlights();
                        }
                      )
                  )
                );
              }}
            />
          ) : null}
        </div>
      </div>
    );
  }
}
