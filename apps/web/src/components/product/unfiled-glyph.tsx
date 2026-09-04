import type { ReactNode } from "react";

/**
 * Unfiled's glyphs, drawn from the mark's own vocabulary: an open tray, a slanted card, and
 * square-capped strokes (ADR-0019, decision 4). The geometry is the same 24-unit box and the
 * same 14-degree card tilt the iPhone app draws in `UnfiledGlyph`, so a control means the same
 * thing on both surfaces. No stock icon set appears on the product screens.
 */
export type UnfiledGlyphName =
  | "archive"
  | "arrow"
  | "back"
  | "bullets"
  | "camera"
  | "card"
  | "check"
  | "checkCircle"
  | "checklist"
  | "chevron"
  | "clock"
  | "close"
  | "down"
  | "heading"
  | "inbox"
  | "info"
  | "library"
  | "link"
  | "lock"
  | "microphone"
  | "minus"
  | "more"
  | "move"
  | "pen"
  | "photo"
  | "plus"
  | "quote"
  | "review"
  | "search"
  | "send"
  | "sliders"
  | "trash"
  | "tray"
  | "undo"
  | "up"
  | "warning";

const CARD_TILT_DEGREES = 14;

/** A slanted card, the same tilt as the mark's card. */
function card(
  key: string,
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  radius: number
): ReactNode {
  return (
    <rect
      key={key}
      x={centerX - width / 2}
      y={centerY - height / 2}
      width={width}
      height={height}
      rx={radius}
      transform={`rotate(${CARD_TILT_DEGREES} ${centerX} ${centerY})`}
    />
  );
}

/** The mark's open tray: two uprights joined by a rounded bottom. */
function tray(key: string, x: number, y: number, width: number, height: number): ReactNode {
  const right = x + width;
  const bottom = y + height;
  const shoulder = bottom - height * 0.3;
  const middle = x + width / 2;
  return (
    <path
      key={key}
      d={`M ${x} ${y} L ${x} ${shoulder} Q ${x} ${bottom} ${middle} ${bottom} Q ${right} ${bottom} ${right} ${shoulder} L ${right} ${y}`}
    />
  );
}

function line(key: string, points: readonly (readonly [number, number])[]): ReactNode {
  const [head, ...rest] = points;
  if (head === undefined) return null;
  const commands = rest.map(([x, y]) => `L ${x} ${y}`).join(" ");
  return <path key={key} d={`M ${head[0]} ${head[1]} ${commands}`} />;
}

/** A mark drawn on a card slants with it, the way the app tilts a check or a lens. */
function tilted(key: string, centerX: number, centerY: number, children: ReactNode): ReactNode {
  return (
    <g key={key} transform={`rotate(${CARD_TILT_DEGREES} ${centerX} ${centerY})`}>
      {children}
    </g>
  );
}

function strokedPaths(glyph: UnfiledGlyphName): ReactNode {
  switch (glyph) {
    case "inbox":
      // The mark itself: a card dropping into the tray. The card is the filled half.
      return tray("tray", 4.5, 7, 15, 12.5);
    case "library":
      // A stack: the back card is drawn, the front card is solid.
      return card("back", 9.5, 13.5, 8, 11.5, 1.2);
    case "pen":
      return [
        card("frame", 12, 12, 11, 15, 1.6),
        line("down", [
          [12, 8.8],
          [12, 15.2]
        ]),
        line("across", [
          [8.8, 12],
          [15.2, 12]
        ])
      ];
    case "review":
      return [
        card("frame", 12, 12, 12, 15.5, 1.6),
        tilted(
          "check",
          12,
          12,
          line("mark", [
            [8.4, 12.4],
            [11, 15],
            [15.8, 9.6]
          ])
        )
      ];
    case "search":
      return [
        card("frame", 12, 12, 12, 15.5, 1.6),
        tilted("lens", 12, 12, [
          <circle key="ring" cx={11.3} cy={10.7} r={3.1} />,
          line("handle", [
            [13.6, 13],
            [16.3, 16.4]
          ])
        ])
      ];
    case "card":
      return card("frame", 12, 12, 12, 15.5, 1.6);
    case "plus":
      return [
        line("down", [
          [12, 5],
          [12, 19]
        ]),
        line("across", [
          [5, 12],
          [19, 12]
        ])
      ];
    case "minus":
      return line("across", [
        [5, 12],
        [19, 12]
      ]);
    case "send":
      return [
        line("shaft", [
          [12, 19.5],
          [12, 5.5]
        ]),
        line("head", [
          [6.5, 11],
          [12, 5.5],
          [17.5, 11]
        ])
      ];
    case "sliders":
      return [
        line("top", [
          [4, 8],
          [20, 8]
        ]),
        line("bottom", [
          [4, 16],
          [20, 16]
        ])
      ];
    case "chevron":
      return line("chevron", [
        [9, 6],
        [15, 12],
        [9, 18]
      ]);
    case "back":
      return line("back", [
        [15, 6],
        [9, 12],
        [15, 18]
      ]);
    case "close":
      return [
        line("down", [
          [7, 7],
          [17, 17]
        ]),
        line("up", [
          [17, 7],
          [7, 17]
        ])
      ];
    case "lock":
      // The shackle is a tray turned over; the body is the filled card.
      return <path key="shackle" d="M 8 11 L 8 8.5 A 4 4 0 0 1 16 8.5 L 16 11" />;
    case "clock":
      return [
        <circle key="face" cx={12} cy={12} r={8} />,
        line("hands", [
          [12, 7.5],
          [12, 12],
          [15.5, 14]
        ])
      ];
    case "warning":
      return [
        card("frame", 12, 12, 11, 15, 1.6),
        line("stem", [
          [12, 8],
          [12, 12.6]
        ])
      ];
    case "tray":
      return [
        tray("tray", 4, 9, 16, 11),
        line("shaft", [
          [12, 3.5],
          [12, 12]
        ]),
        line("head", [
          [8.8, 8.8],
          [12, 12],
          [15.2, 8.8]
        ])
      ];
    case "check":
      return line("check", [
        [5, 12.5],
        [10, 17.5],
        [19, 7.5]
      ]);
    case "checkCircle":
      return [
        <circle key="ring" cx={12} cy={12} r={8} />,
        line("check", [
          [8, 12.3],
          [11, 15.3],
          [16.3, 9.3]
        ])
      ];
    case "archive":
      return [
        tray("tray", 4.5, 9, 15, 11),
        line("lid", [
          [4, 5.5],
          [20, 5.5]
        ])
      ];
    case "trash":
      return [
        line("lid", [
          [4.5, 7],
          [19.5, 7]
        ]),
        line("handle", [
          [9.5, 7],
          [9.5, 4.5],
          [14.5, 4.5],
          [14.5, 7]
        ]),
        tray("body", 6.5, 7, 11, 13)
      ];
    case "heading":
      return [
        line("first", [
          [5, 15],
          [19, 15]
        ]),
        line("second", [
          [5, 19],
          [14, 19]
        ])
      ];
    case "bullets":
      return [
        line("first", [
          [10, 6.5],
          [19, 6.5]
        ]),
        line("second", [
          [10, 12],
          [19, 12]
        ]),
        line("third", [
          [10, 17.5],
          [19, 17.5]
        ])
      ];
    case "checklist":
      return [
        line("check-one", [
          [4.5, 8],
          [6.6, 10.1],
          [10, 5.9]
        ]),
        line("line-one", [
          [12.5, 8],
          [19.5, 8]
        ]),
        line("check-two", [
          [4.5, 16],
          [6.6, 18.1],
          [10, 13.9]
        ]),
        line("line-two", [
          [12.5, 16],
          [19.5, 16]
        ])
      ];
    case "link":
      return [
        <rect key="left" x={3.5} y={9} width={10} height={6} rx={3} />,
        <rect key="right" x={10.5} y={9} width={10} height={6} rx={3} />
      ];
    case "arrow":
      return [
        line("shaft", [
          [4.5, 12],
          [19, 12]
        ]),
        line("head", [
          [13.5, 6.5],
          [19, 12],
          [13.5, 17.5]
        ])
      ];
    case "down":
      return [
        line("shaft", [
          [12, 4.5],
          [12, 19]
        ]),
        line("head", [
          [6.5, 13.5],
          [12, 19],
          [17.5, 13.5]
        ])
      ];
    case "up":
      return line("up", [
        [6, 15],
        [12, 9],
        [18, 15]
      ]);
    case "move":
      // Down from where it was, then out to the right: the card goes somewhere else.
      return [
        line("path", [
          [5.5, 5],
          [5.5, 13.5],
          [18.5, 13.5]
        ]),
        line("head", [
          [13.5, 8.5],
          [18.5, 13.5],
          [13.5, 18.5]
        ])
      ];
    case "undo":
      // Back the way it came: a line that turns and points left again.
      return [
        <path key="turn" d="M 7 9 L 15.5 9 A 3.5 3.5 0 0 1 15.5 16 L 9 16" />,
        line("head", [
          [10.5, 5.5],
          [7, 9],
          [10.5, 12.5]
        ])
      ];
    case "info":
      return [
        <circle key="ring" cx={12} cy={12} r={8} />,
        line("stem", [
          [12, 11],
          [12, 16.5]
        ])
      ];
    case "photo":
      // A print: an upright frame with one ridge across it and the sun above. No tilt;
      // the card slants only where a card is the subject.
      return [
        <rect key="frame" x={4.5} y={6} width={15} height={12} rx={1.6} />,
        line("ridge", [
          [6.6, 15.4],
          [11.2, 10.4],
          [17.4, 15.4]
        ])
      ];
    case "camera":
      return [
        tray("body", 3.5, 8, 17, 11.5),
        line("hood", [
          [8.6, 8],
          [9.9, 5.2],
          [14.1, 5.2],
          [15.4, 8]
        ]),
        <circle key="lens" cx={12} cy={13.4} r={3} />
      ];
    case "microphone":
      return [
        <rect key="capsule" x={9.6} y={4} width={4.8} height={9.6} rx={2.4} />,
        <path key="cradle" d="M 17 12 A 5 5 0 0 1 7 12" />,
        line("stand", [
          [12, 17],
          [12, 20]
        ])
      ];
    case "more":
    case "quote":
      return null;
  }
}

function filledPaths(glyph: UnfiledGlyphName): ReactNode {
  switch (glyph) {
    case "inbox":
      return card("dropping", 13, 7.5, 4.2, 8.5, 0.8);
    case "library":
      return card("front", 14.5, 10.5, 8, 11.5, 1.2);
    case "sliders":
      return [card("top-knob", 15.5, 8, 3.4, 6, 0.8), card("bottom-knob", 8.5, 16, 3.4, 6, 0.8)];
    case "more":
      return [6, 12, 18].map((x) => card(`dot-${x}`, x, 12, 3, 5, 0.7));
    case "lock":
      return card("body", 12, 15.5, 13, 9, 1.6);
    case "warning":
      return <circle key="dot" cx={12} cy={15.7} r={1.1} />;
    case "heading":
      return card("title", 8.5, 8, 5.5, 7, 0.8);
    case "bullets":
      return [6.5, 12, 17.5].map((y) => card(`bullet-${y}`, 6, y, 2.6, 2.6, 0.5));
    case "info":
      return <circle key="dot" cx={12} cy={8} r={1.1} />;
    case "photo":
      // The sun in the frame, the same solid dot the mark's card uses.
      return <circle key="sun" cx={15.7} cy={8.9} r={1.3} />;
    case "quote":
      // Two slanted cards, the way quotation marks sit.
      return [card("open", 8.5, 12, 3.6, 7, 0.8), card("close", 15.5, 12, 3.6, 7, 0.8)];
    default:
      return null;
  }
}

export type UnfiledGlyphProps = Readonly<{
  className?: string;
  glyph: UnfiledGlyphName;
  /** Edge length in pixels. The 24-unit box scales to whatever a row or a dock needs. */
  size?: number;
  /** Stroke width in glyph units, the app's `weight`. */
  weight?: number;
}>;

export function UnfiledGlyph({ className, glyph, size = 20, weight = 2 }: UnfiledGlyphProps) {
  const stroked = strokedPaths(glyph);
  const filled = filledPaths(glyph);
  return (
    <svg
      aria-hidden="true"
      className={className}
      data-glyph={glyph}
      focusable="false"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      {stroked === null ? null : (
        <g
          fill="none"
          stroke="currentColor"
          strokeLinecap="square"
          strokeLinejoin="round"
          strokeWidth={weight}
        >
          {stroked}
        </g>
      )}
      {filled === null ? null : (
        <g fill="currentColor" stroke="none">
          {filled}
        </g>
      )}
    </svg>
  );
}
