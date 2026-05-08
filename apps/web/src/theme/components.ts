import {
  ActionIcon,
  Alert,
  Autocomplete,
  Badge,
  Button,
  Checkbox,
  Combobox,
  Drawer,
  Loader,
  Menu,
  Modal,
  MultiSelect,
  NumberInput,
  Paper,
  Popover,
  Progress,
  Radio,
  ScrollArea,
  Select,
  SegmentedControl,
  Skeleton,
  Switch,
  Tabs,
  Table,
  Textarea,
  TextInput,
  Tooltip,
  type MantineThemeOverride,
} from "@mantine/core";

const inputClassNames = {
  root: "kodex-mantine-input-root",
  wrapper: "kodex-mantine-input-wrapper",
  input: "kodex-mantine-input",
  label: "kodex-mantine-input-label",
  description: "kodex-mantine-input-description",
  error: "kodex-mantine-input-error",
  section: "kodex-mantine-input-section",
};

const comboboxClassNames = {
  dropdown: "kodex-mantine-combobox-dropdown",
  option: "kodex-mantine-combobox-option",
  options: "kodex-mantine-combobox-options",
  empty: "kodex-mantine-combobox-empty",
  footer: "kodex-mantine-combobox-footer",
  header: "kodex-mantine-combobox-header",
  group: "kodex-mantine-combobox-group",
  groupLabel: "kodex-mantine-combobox-group-label",
};

const inlineInputClassNames = {
  root: "kodex-mantine-inline-input-root",
  body: "kodex-mantine-inline-input-body",
  labelWrapper: "kodex-mantine-inline-input-label-wrapper",
  label: "kodex-mantine-inline-input-label",
  description: "kodex-mantine-inline-input-description",
  error: "kodex-mantine-inline-input-error",
};

const selectionControlClassNames = {
  ...inlineInputClassNames,
  inner: "kodex-mantine-selection-inner",
  input: "kodex-mantine-selection-input",
  icon: "kodex-mantine-selection-icon",
};

export function createKodexMantineComponents(): MantineThemeOverride["components"] {
  return {
    TextInput: TextInput.extend({
      defaultProps: {
        radius: "md",
        size: "sm",
        classNames: inputClassNames,
      },
    }),
    Textarea: Textarea.extend({
      defaultProps: {
        radius: "md",
        size: "sm",
        classNames: inputClassNames,
      },
    }),
    Select: Select.extend({
      defaultProps: {
        radius: "md",
        size: "sm",
        classNames: {
          ...inputClassNames,
          ...comboboxClassNames,
        },
      },
    }),
    Autocomplete: Autocomplete.extend({
      defaultProps: {
        radius: "md",
        size: "sm",
        classNames: {
          ...inputClassNames,
          ...comboboxClassNames,
        },
      },
    }),
    MultiSelect: MultiSelect.extend({
      defaultProps: {
        radius: "md",
        size: "sm",
        classNames: {
          ...inputClassNames,
          ...comboboxClassNames,
          pill: "kodex-mantine-multi-select-pill",
          pillsList: "kodex-mantine-multi-select-pills-list",
          inputField: "kodex-mantine-multi-select-input-field",
        },
      },
    }),
    NumberInput: NumberInput.extend({
      defaultProps: {
        radius: "md",
        size: "sm",
        classNames: {
          ...inputClassNames,
          controls: "kodex-mantine-number-input-controls",
          control: "kodex-mantine-number-input-control",
        },
      },
    }),
    Checkbox: Checkbox.extend({
      defaultProps: {
        radius: "sm",
        size: "sm",
        classNames: selectionControlClassNames,
      },
    }),
    Switch: Switch.extend({
      defaultProps: {
        radius: "xl",
        size: "sm",
        classNames: {
          ...inlineInputClassNames,
          input: "kodex-mantine-switch-input",
          track: "kodex-mantine-switch-track",
          trackLabel: "kodex-mantine-switch-track-label",
          thumb: "kodex-mantine-switch-thumb",
        },
      },
    }),
    Radio: Radio.extend({
      defaultProps: {
        size: "sm",
        classNames: {
          ...selectionControlClassNames,
          radio: "kodex-mantine-radio-input",
        },
      },
    }),
    Combobox: Combobox.extend({
      defaultProps: {
        size: "sm",
        classNames: {
          ...comboboxClassNames,
          search: "kodex-mantine-combobox-search",
        },
      },
    }),
    Menu: Menu.extend({
      defaultProps: {
        classNames: {
          dropdown: "kodex-mantine-menu-dropdown",
          label: "kodex-mantine-menu-label",
          divider: "kodex-mantine-menu-divider",
          item: "kodex-mantine-menu-item",
          itemSection: "kodex-mantine-menu-item-section",
          itemLabel: "kodex-mantine-menu-item-label",
        },
      },
    }),
    Popover: Popover.extend({
      defaultProps: {
        radius: "md",
        shadow: "md",
        classNames: {
          dropdown: "kodex-mantine-popover-dropdown",
          arrow: "kodex-mantine-popover-arrow",
          overlay: "kodex-mantine-popover-overlay",
        },
      },
    }),
    Tooltip: Tooltip.extend({
      defaultProps: {
        radius: "sm",
        withArrow: true,
        classNames: {
          tooltip: "kodex-mantine-tooltip",
          arrow: "kodex-mantine-tooltip-arrow",
        },
      },
    }),
    Modal: Modal.extend({
      defaultProps: {
        classNames: {
          overlay: "kodex-mantine-modal-overlay",
          content: "kodex-mantine-modal-content",
          header: "kodex-mantine-modal-header",
          body: "kodex-mantine-modal-body",
          title: "kodex-mantine-modal-title",
          close: "kodex-mantine-modal-close",
        },
      },
    }),
    Drawer: Drawer.extend({
      defaultProps: {
        classNames: {
          overlay: "kodex-mantine-drawer-overlay",
          content: "kodex-mantine-drawer-content",
          header: "kodex-mantine-drawer-header",
          body: "kodex-mantine-drawer-body",
          title: "kodex-mantine-drawer-title",
          close: "kodex-mantine-drawer-close",
        },
      },
    }),
    Button: Button.extend({
      defaultProps: {
        radius: "sm",
        classNames: {
          root: "kodex-mantine-button-root",
          inner: "kodex-mantine-button-inner",
          label: "kodex-mantine-button-label",
          section: "kodex-mantine-button-section",
        },
      },
    }),
    ActionIcon: ActionIcon.extend({
      defaultProps: {
        radius: "sm",
        variant: "subtle",
        classNames: {
          root: "kodex-mantine-action-icon-root",
          icon: "kodex-mantine-action-icon-icon",
        },
      },
    }),
    Badge: Badge.extend({
      defaultProps: {
        radius: "sm",
        classNames: {
          root: "kodex-mantine-badge-root",
          label: "kodex-mantine-badge-label",
          section: "kodex-mantine-badge-section",
        },
      },
    }),
    Tabs: Tabs.extend({
      defaultProps: {
        classNames: {
          root: "kodex-mantine-tabs-root",
          list: "kodex-mantine-tabs-list",
          tab: "kodex-mantine-tabs-tab",
          tabSection: "kodex-mantine-tabs-tab-section",
          tabLabel: "kodex-mantine-tabs-tab-label",
          panel: "kodex-mantine-tabs-panel",
        },
      },
    }),
    SegmentedControl: SegmentedControl.extend({
      defaultProps: {
        radius: "md",
        size: "sm",
        classNames: {
          root: "kodex-mantine-segmented-control-root",
          control: "kodex-mantine-segmented-control-control",
          indicator: "kodex-mantine-segmented-control-indicator",
          label: "kodex-mantine-segmented-control-label",
          innerLabel: "kodex-mantine-segmented-control-inner-label",
        },
      },
    }),
    Alert: Alert.extend({
      defaultProps: {
        radius: "md",
        classNames: {
          root: "kodex-mantine-alert-root",
          wrapper: "kodex-mantine-alert-wrapper",
          icon: "kodex-mantine-alert-icon",
          body: "kodex-mantine-alert-body",
          title: "kodex-mantine-alert-title",
          message: "kodex-mantine-alert-message",
          closeButton: "kodex-mantine-alert-close",
        },
      },
    }),
    Table: Table.extend({
      defaultProps: {
        verticalSpacing: "xs",
        horizontalSpacing: "sm",
        withRowBorders: true,
        classNames: {
          table: "kodex-mantine-table",
          thead: "kodex-mantine-table-thead",
          tbody: "kodex-mantine-table-tbody",
          tfoot: "kodex-mantine-table-tfoot",
          tr: "kodex-mantine-table-tr",
          th: "kodex-mantine-table-th",
          td: "kodex-mantine-table-td",
          caption: "kodex-mantine-table-caption",
        },
      },
    }),
    Paper: Paper.extend({
      defaultProps: {
        radius: "md",
        classNames: {
          root: "kodex-mantine-paper-root",
        },
      },
    }),
    ScrollArea: ScrollArea.extend({
      defaultProps: {
        scrollbarSize: 8,
        classNames: {
          root: "kodex-mantine-scroll-area-root",
          viewport: "kodex-mantine-scroll-area-viewport",
          scrollbar: "kodex-mantine-scroll-area-scrollbar",
          thumb: "kodex-mantine-scroll-area-thumb",
          corner: "kodex-mantine-scroll-area-corner",
          content: "kodex-mantine-scroll-area-content",
        },
      },
    }),
    Loader: Loader.extend({
      defaultProps: {
        color: "accent",
        type: "oval",
        classNames: {
          root: "kodex-mantine-loader-root",
        },
      },
    }),
    Progress: Progress.extend({
      defaultProps: {
        radius: "xl",
        size: "sm",
        classNames: {
          root: "kodex-mantine-progress-root",
          section: "kodex-mantine-progress-section",
          label: "kodex-mantine-progress-label",
        },
      },
    }),
    Skeleton: Skeleton.extend({
      defaultProps: {
        radius: "sm",
        classNames: {
          root: "kodex-mantine-skeleton-root",
        },
      },
    }),
  };
}
