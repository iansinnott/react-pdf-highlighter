import { PointerEventHandler, PureComponent } from "react";
import ReactDom from "react-dom/client";
import { EventBus, PDFViewer, PDFLinkService } from "pdfjs-dist/legacy/web/pdf_viewer";
import "pdfjs-dist/web/pdf_viewer.css";
import "../style/pdf_viewer.css";
import "../style/PdfHighlighter.css";
import type { Position, ScaledPosition, IHighlight, Scaled, LTWH, LTWHP } from "../types";
import type { PDFDocumentProxy } from "pdfjs-dist";
declare type T_ViewportHighlight<T_HT> = {
    position: Position;
} & T_HT;
interface State<T_HT> {
    ghostHighlight: {
        position: ScaledPosition;
        content?: {
            text?: string;
            image?: string;
        };
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
    highlightTransform: (highlight: T_ViewportHighlight<T_HT>, index: number, setTip: (highlight: T_ViewportHighlight<T_HT>, callback: (highlight: T_ViewportHighlight<T_HT>) => JSX.Element) => void, hideTip: () => void, viewportToScaled: (rect: LTWHP) => Scaled, screenshot: (position: LTWH) => string, isScrolledTo: boolean) => JSX.Element;
    highlights: Array<T_HT>;
    onScrollChange: () => void;
    scrollRef: (scrollTo: (highlight: IHighlight) => void) => void;
    pdfDocument: PDFDocumentProxy;
    /**
     * Should be one of the predefined values or a numeric string, such as "1.2"
     */
    pdfScaleValue: "auto" | "page-width" | "page-fit" | string;
    onSelectionFinished: (position: ScaledPosition, content: {
        text?: string;
        image?: string;
    }, hideTipAndSelection: () => void, transformSelection: () => void) => JSX.Element | null;
    enableAreaSelection: (event: MouseEvent) => boolean;
    resizeDebounceMs: number;
    selectionDebounceMs: number;
}
export declare class PdfHighlighter<T_HT extends IHighlight> extends PureComponent<Props<T_HT>, State<T_HT>> {
    static defaultProps: {
        pdfScaleValue: string;
        resizeDebounceMs: number;
        selectionDebounceMs: number;
    };
    state: State<T_HT>;
    eventBus: EventBus;
    linkService: PDFLinkService;
    viewer: PDFViewer;
    resizeObserver: ResizeObserver | null;
    containerNode?: HTMLDivElement | null;
    unsubscribe: () => void;
    constructor(props: Props<T_HT>);
    validateProps(): void;
    componentDidMount(): void;
    attachRef: (ref: HTMLDivElement | null) => void;
    componentDidUpdate(prevProps: Props<T_HT>): void;
    init(): void;
    componentWillUnmount(): void;
    roots: Map<any, any>;
    findOrCreateHighlightLayer(page: number): ReactDom.Root | null;
    groupHighlightsByPage(highlights: Array<T_HT>): {
        [pageNumber: string]: Array<T_HT>;
    };
    showTip(highlight: T_ViewportHighlight<T_HT>, content: JSX.Element): void;
    scaledPositionToViewport({ pageNumber, boundingRect, rects, usePdfCoordinates, }: ScaledPosition): Position;
    viewportPositionToScaled({ pageNumber, boundingRect, rects, }: Position): ScaledPosition;
    screenshot(position: LTWH, pageNumber: number): string;
    renderHighlights(nextProps?: Props<T_HT>): void;
    hideTipAndSelection: () => void;
    setTip(position: Position, inner: JSX.Element | null): void;
    renderTip: () => JSX.Element | null;
    onTextLayerRendered: () => void;
    scrollTo: (highlight: IHighlight) => void;
    onDocumentReady: () => void;
    onSelectionChange: () => void;
    onScroll: () => void;
    onMouseDown: PointerEventHandler;
    handleKeyDown: (event: KeyboardEvent) => void;
    afterSelection: () => void;
    debouncedAfterSelection: () => void;
    toggleTextSelection(flag: boolean): void;
    handleScaleValue: () => void;
    debouncedScaleValue: () => void;
    render(): JSX.Element;
}
export {};
