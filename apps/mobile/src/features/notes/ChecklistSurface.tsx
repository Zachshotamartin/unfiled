import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { nativeTheme } from "../../theme/nativeTheme";
import { toggleChecklistItemLocally, type ChecklistItemView } from "./checklists";

interface ChecklistSurfaceProps {
  items: ChecklistItemView[];
  onToggle: (itemId: string, checked: boolean) => Promise<void>;
}

export function ChecklistSurface({ items, onToggle }: ChecklistSurfaceProps): ReactElement {
  const [localItems, setLocalItems] = useState(items);
  const [showCompleted, setShowCompleted] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => setLocalItems(items), [items]);

  const open = useMemo(() => localItems.filter((item) => !item.checked), [localItems]);
  const completed = useMemo(() => localItems.filter((item) => item.checked), [localItems]);

  const toggle = async (item: ChecklistItemView): Promise<void> => {
    if (busyId !== null) return;
    const checked = !item.checked;
    const previous = localItems;
    setBusyId(item.id);
    setLocalItems(toggleChecklistItemLocally(previous, item.id, checked));
    try {
      await onToggle(item.id, checked);
      const remaining = checked ? open.length - 1 : open.length + 1;
      setAnnouncement(
        `${item.text}, ${checked ? "checked" : "unchecked"}, ${remaining} of ${localItems.length} remaining.`
      );
    } catch {
      setLocalItems(previous);
      setAnnouncement("That update conflicted with a newer revision. The note was reloaded.");
    } finally {
      setBusyId(null);
    }
  };

  const row = (item: ChecklistItemView): ReactElement => (
    <Pressable
      key={item.id}
      accessibilityLabel={item.text}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: item.checked, disabled: busyId !== null }}
      disabled={busyId !== null}
      onPress={() => void toggle(item)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Ionicons
        color={item.checked ? nativeTheme.color.textSecondary : nativeTheme.color.accent}
        name={item.checked ? "checkbox" : "square-outline"}
        size={24}
      />
      <Text style={[styles.itemText, item.checked && styles.completedText]}>{item.text}</Text>
    </Pressable>
  );

  return (
    <View style={styles.surface}>
      <Text accessibilityRole="header" style={styles.heading}>
        Checklist · {open.length} remaining
      </Text>
      {open.map(row)}
      {completed.length > 0 ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showCompleted }}
            onPress={() => setShowCompleted((value) => !value)}
            style={styles.completedToggle}
          >
            <Ionicons
              color={nativeTheme.color.textSecondary}
              name={showCompleted ? "chevron-down" : "chevron-forward"}
              size={17}
            />
            <Text style={styles.completedLabel}>{completed.length} completed</Text>
          </Pressable>
          {showCompleted ? completed.map(row) : null}
        </>
      ) : null}
      <Text accessibilityLiveRegion="polite" style={styles.announcement}>
        {announcement}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  announcement: { color: nativeTheme.color.textSecondary, fontSize: 12, minHeight: 18 },
  completedLabel: { color: nativeTheme.color.textSecondary, fontSize: 13, fontWeight: "600" },
  completedText: { color: nativeTheme.color.textSecondary, textDecorationLine: "line-through" },
  completedToggle: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    minHeight: 44,
    paddingVertical: 8
  },
  heading: {
    color: nativeTheme.color.textSecondary,
    fontFamily: nativeTheme.fontFamily.mono,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.7,
    marginBottom: 8,
    textTransform: "uppercase"
  },
  itemText: { color: nativeTheme.color.textPrimary, flex: 1, fontSize: 16, lineHeight: 23 },
  pressed: { opacity: 0.62 },
  row: { alignItems: "center", flexDirection: "row", gap: 12, minHeight: 48, paddingVertical: 8 },
  surface: {
    borderBottomColor: nativeTheme.color.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderTopColor: nativeTheme.color.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginBottom: 24,
    paddingVertical: 18
  }
});
