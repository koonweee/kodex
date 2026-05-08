import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Drawer,
  Menu,
  Modal,
  NumberInput,
  Select,
  SegmentedControl,
  Tabs,
  Textarea,
  TextInput,
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
          dropdown: "kodex-mantine-combobox-dropdown",
          option: "kodex-mantine-combobox-option",
          options: "kodex-mantine-combobox-options",
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
  };
}
