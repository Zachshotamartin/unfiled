import { Fragment, type ReactElement, type ReactNode } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";

import { nativeTheme } from "../../theme/nativeTheme";

interface MarkdownPreviewProps {
  markdown: string;
}

export function MarkdownPreview({ markdown }: MarkdownPreviewProps): ReactElement {
  if (markdown.length === 0) {
    return <Text style={styles.empty}>Nothing to preview yet.</Text>;
  }

  return (
    <View accessibilityLabel="Markdown preview" style={styles.root}>
      {markdown.split("\n").map((line, index) => (
        <MarkdownLine key={`${index}:${line}`} line={line} />
      ))}
    </View>
  );
}

function MarkdownLine({ line }: { line: string }): ReactElement {
  const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
  if (heading !== null) {
    const level = heading[1]?.length ?? 1;
    return (
      <Text accessibilityRole="header" style={[styles.text, headingStyle(level)]}>
        {inlineNodes(heading[2] ?? "")}
      </Text>
    );
  }

  const checklist = /^\s*-\s+\[([ xX])\]\s+(.+)$/u.exec(line);
  if (checklist !== null) {
    const checked = checklist[1]?.toLowerCase() === "x";
    return (
      <View style={styles.listRow}>
        <Text style={styles.marker}>{checked ? "✓" : "○"}</Text>
        <Text style={[styles.text, checked && styles.checked]}>
          {inlineNodes(checklist[2] ?? "")}
        </Text>
      </View>
    );
  }

  const bullet = /^\s*[-*+]\s+(.+)$/u.exec(line);
  if (bullet !== null) {
    return (
      <View style={styles.listRow}>
        <Text style={styles.marker}>•</Text>
        <Text style={styles.text}>{inlineNodes(bullet[1] ?? "")}</Text>
      </View>
    );
  }

  const ordered = /^\s*(\d+)\.\s+(.+)$/u.exec(line);
  if (ordered !== null) {
    return (
      <View style={styles.listRow}>
        <Text style={styles.number}>{ordered[1]}.</Text>
        <Text style={styles.text}>{inlineNodes(ordered[2] ?? "")}</Text>
      </View>
    );
  }

  const quote = /^>\s?(.*)$/u.exec(line);
  if (quote !== null) {
    return (
      <View style={styles.quote}>
        <Text style={[styles.text, styles.quoteText]}>{inlineNodes(quote[1] ?? "")}</Text>
      </View>
    );
  }

  if (line.trim().length === 0) return <View style={styles.break} />;
  return <Text style={styles.text}>{inlineNodes(line)}</Text>;
}

function headingStyle(level: number) {
  if (level === 1) return styles.h1;
  if (level === 2) return styles.h2;
  return styles.h3;
}

function inlineNodes(text: string): ReactNode[] {
  const tokenPattern =
    /(\*\*[^*]+\*\*|\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)]+\)|\[\[[^\]]+\]\]|#[\p{L}\p{N}_-]+)/gu;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const start = match.index;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    const token = match[0];
    if (token.startsWith("**")) {
      nodes.push(
        <Text key={`${start}:bold`} style={styles.bold}>
          {token.slice(2, -2)}
        </Text>
      );
    } else if (token.startsWith("[[")) {
      nodes.push(
        <Text key={`${start}:note`} style={styles.noteLink}>
          {token.slice(2, -2)}
        </Text>
      );
    } else if (token.startsWith("#")) {
      nodes.push(
        <Text key={`${start}:tag`} style={styles.tag}>
          {token}
        </Text>
      );
    } else {
      const parsed = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(token);
      if (parsed !== null) {
        const url = parsed[2] ?? "";
        nodes.push(
          <Text
            key={`${start}:link`}
            accessibilityRole="link"
            onPress={() => void Linking.openURL(url)}
            style={styles.link}
          >
            {parsed[1]}
          </Text>
        );
      }
    }
    cursor = start + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes.map((node, index) => <Fragment key={index}>{node}</Fragment>);
}

const styles = StyleSheet.create({
  bold: { fontWeight: "800" },
  break: { height: 14 },
  checked: { color: nativeTheme.color.textSecondary, textDecorationLine: "line-through" },
  empty: { color: nativeTheme.color.textSecondary, fontSize: 15, lineHeight: 24 },
  h1: { fontSize: 28, fontWeight: "700", letterSpacing: -0.5, marginBottom: 8, marginTop: 18 },
  h2: { fontSize: 23, fontWeight: "700", letterSpacing: -0.3, marginBottom: 6, marginTop: 16 },
  h3: { fontSize: 19, fontWeight: "700", marginBottom: 4, marginTop: 12 },
  link: { color: nativeTheme.color.accent, textDecorationLine: "underline" },
  listRow: { alignItems: "flex-start", flexDirection: "row", gap: 10, minHeight: 30 },
  marker: { color: nativeTheme.color.accent, fontSize: 17, lineHeight: 27, width: 18 },
  noteLink: { color: nativeTheme.color.accent, fontWeight: "700" },
  number: { color: nativeTheme.color.textSecondary, fontSize: 15, lineHeight: 27, width: 24 },
  quote: {
    borderLeftColor: nativeTheme.color.accent,
    borderLeftWidth: 2,
    marginVertical: 6,
    paddingLeft: 14
  },
  quoteText: { color: nativeTheme.color.textSecondary, fontStyle: "italic" },
  root: { gap: 2, minHeight: 330, paddingVertical: 20 },
  tag: { color: nativeTheme.color.accent, fontWeight: "700" },
  text: { color: nativeTheme.color.textPrimary, flexShrink: 1, fontSize: 17, lineHeight: 27 }
});
