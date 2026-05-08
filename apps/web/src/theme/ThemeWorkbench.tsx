import {
  ActionIcon,
  Alert,
  Autocomplete,
  Badge,
  Box,
  Button,
  Checkbox,
  Combobox,
  Drawer,
  Group,
  Loader,
  Menu,
  Modal,
  MultiSelect,
  NumberInput,
  Paper,
  Select,
  SegmentedControl,
  Skeleton,
  Stack,
  Switch,
  Tabs,
  Table,
  Text,
  Textarea,
  TextInput,
  Tooltip,
  Popover,
  Progress,
  Radio,
  ScrollArea,
  useCombobox,
} from "@mantine/core";
import { Bell, Check, Menu as MenuIcon, PanelRightOpen, Settings, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import {
  applyKodexColorScheme,
  DEFAULT_KODEX_COLOR_SCHEME_ID,
  getKodexColorScheme,
  KODEX_COLOR_SCHEMES,
  readStoredKodexColorScheme,
  writeStoredKodexColorScheme,
  type KodexColorSchemeId,
} from "../theme";

type ThemeWorkbenchProps = {
  colorSchemeId?: KodexColorSchemeId;
  initialColorSchemeId?: KodexColorSchemeId;
  onColorSchemeChange?: (colorSchemeId: KodexColorSchemeId) => void;
};

export function ThemeWorkbench({
  colorSchemeId,
  initialColorSchemeId,
  onColorSchemeChange,
}: ThemeWorkbenchProps) {
  const [localColorSchemeId, setLocalColorSchemeId] = useState<KodexColorSchemeId>(
    () => initialColorSchemeId ?? readStoredKodexColorScheme() ?? DEFAULT_KODEX_COLOR_SCHEME_ID,
  );
  const [modalOpen, setModalOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [comboboxValue, setComboboxValue] = useState("Inbox");
  const combobox = useCombobox({
    onDropdownClose: () => combobox.resetSelectedOption(),
  });
  const activeColorSchemeId = colorSchemeId ?? localColorSchemeId;
  const activeColorScheme = getKodexColorScheme(activeColorSchemeId);

  useEffect(() => {
    writeStoredKodexColorScheme(activeColorSchemeId);
    applyKodexColorScheme(document.documentElement, activeColorScheme);
  }, [activeColorScheme, activeColorSchemeId]);

  function handleColorSchemeChange(nextColorSchemeId: KodexColorSchemeId) {
    setLocalColorSchemeId(nextColorSchemeId);
    onColorSchemeChange?.(nextColorSchemeId);
  }

  return (
    <Box
      aria-label="Theme workbench"
      component="main"
      className="kodex-theme-workbench"
      data-scheme={activeColorScheme.id}
    >
      <Stack gap="lg">
        <Group align="flex-start" justify="space-between" wrap="wrap">
          <Stack gap={4}>
            <Text fw={750} size="xl">
              Theme workbench
            </Text>
            <Text c="dimmed" size="sm">
              {activeColorScheme.label}
            </Text>
          </Stack>

          <Box aria-label="Color scheme" className="kodex-theme-workbench-schemes" role="radiogroup">
            {KODEX_COLOR_SCHEMES.map((scheme) => (
              <button
                aria-checked={scheme.id === activeColorSchemeId}
                className="kodex-ui-button kodex-ui-selectable kodex-theme-workbench-scheme"
                data-active={scheme.id === activeColorSchemeId ? "true" : undefined}
                key={scheme.id}
                onClick={() => handleColorSchemeChange(scheme.id)}
                role="radio"
                tabIndex={scheme.id === activeColorSchemeId ? 0 : -1}
                type="button"
              >
                <span>{scheme.label}</span>
                <span aria-hidden="true" className="kodex-theme-workbench-swatches">
                  {scheme.swatches.map((swatch) => (
                    <span className="kodex-theme-workbench-swatch" key={swatch} style={{ background: swatch }} />
                  ))}
                </span>
              </button>
            ))}
          </Box>
        </Group>

        <div className="kodex-theme-workbench-grid">
          <section className="kodex-theme-workbench-section" aria-label="Form controls">
            <Stack gap="sm">
              <Text fw={700}>Form controls</Text>
              <TextInput label="Plain text input" placeholder="Untitled automation" description="Default input chrome" />
              <Textarea label="Plain textarea" minRows={3} placeholder="Write a prompt" />
              <Select
                data={[
                  { value: "thread", label: "Thread" },
                  { value: "project", label: "Project" },
                  { value: "automation", label: "Automation" },
                ]}
                defaultValue="thread"
                label="Plain select"
              />
              <NumberInput defaultValue={3} label="Plain number input" min={1} />
              <Autocomplete
                data={["thread settings", "timeline rendering", "automation prompt"]}
                label="Plain autocomplete"
                placeholder="Search commands"
              />
              <MultiSelect
                data={[
                  { value: "frontend", label: "Frontend" },
                  { value: "backend", label: "Backend" },
                  { value: "docs", label: "Docs" },
                ]}
                defaultValue={["frontend", "docs"]}
                label="Plain multi select"
              />
              <TextInput disabled label="Disabled input" defaultValue="Unavailable" />
              <TextInput error="Field is required" label="Error input" defaultValue="" />
            </Stack>
          </section>

          <section className="kodex-theme-workbench-section" aria-label="Selection controls">
            <Stack gap="sm">
              <Text fw={700}>Selection controls</Text>
              <Checkbox defaultChecked description="Inline checkbox description" label="Plain checkbox" />
              <Switch defaultChecked label="Plain switch" />
              <Radio.Group defaultValue="allow" label="Plain radio group">
                <Group mt="xs">
                  <Radio label="Allow" value="allow" />
                  <Radio label="Ask" value="ask" />
                </Group>
              </Radio.Group>
            </Stack>
          </section>

          <section className="kodex-theme-workbench-section" aria-label="Overlays">
            <Stack gap="sm">
              <Text fw={700}>Overlays</Text>
              <Menu position="bottom-start">
                <Menu.Target>
                  <Button leftSection={<MenuIcon size={15} />} variant="light">
                    Open menu
                  </Button>
                </Menu.Target>
                <Menu.Dropdown aria-label="Workbench menu">
                  <Menu.Label>Thread</Menu.Label>
                  <Menu.Item leftSection={<Check size={14} />}>Archive</Menu.Item>
                  <Menu.Item data-active="true" leftSection={<Bell size={14} />}>
                    Follow
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Item color="red" leftSection={<Trash2 size={14} />}>
                    Delete
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>

              <Group gap="xs">
                <Button onClick={() => setModalOpen(true)} variant="light">
                  Open modal
                </Button>
                <Button leftSection={<PanelRightOpen size={15} />} onClick={() => setDrawerOpen(true)} variant="light">
                  Open drawer
                </Button>
              </Group>

              <Combobox
                store={combobox}
                onOptionSubmit={(value) => {
                  setComboboxValue(value);
                  combobox.closeDropdown();
                }}
              >
                <Combobox.Target>
                  <Button
                    aria-label="Plain combobox"
                    onClick={() => combobox.toggleDropdown()}
                    rightSection={<MenuIcon size={14} />}
                    variant="light"
                  >
                    {comboboxValue}
                  </Button>
                </Combobox.Target>
                <Combobox.Dropdown>
                  <Combobox.Options>
                    {["Inbox", "Pinned", "Archived"].map((option) => (
                      <Combobox.Option key={option} value={option}>
                        {option}
                      </Combobox.Option>
                    ))}
                  </Combobox.Options>
                </Combobox.Dropdown>
              </Combobox>

              <Group gap="xs">
                <Popover opened={popoverOpen} onChange={setPopoverOpen} position="bottom-start" withArrow>
                  <Popover.Target>
                    <Button onClick={() => setPopoverOpen((opened) => !opened)} variant="light">
                      Open popover
                    </Button>
                  </Popover.Target>
                  <Popover.Dropdown>
                    <Text size="sm">Popover surface uses default chrome.</Text>
                  </Popover.Dropdown>
                </Popover>
                <Tooltip label="Themed tooltip" opened>
                  <Button variant="subtle">Tooltip target</Button>
                </Tooltip>
              </Group>

              <Modal opened={modalOpen} onClose={() => setModalOpen(false)} title="Themed modal">
                <Text size="sm">Modal surface, header, close button, and body use default Kodex classes.</Text>
              </Modal>

              <Drawer opened={drawerOpen} onClose={() => setDrawerOpen(false)} position="right" title="Themed drawer">
                <Text size="sm">Drawer surface and header use default Kodex classes.</Text>
              </Drawer>
            </Stack>
          </section>

          <section className="kodex-theme-workbench-section" aria-label="Buttons and status">
            <Stack gap="sm">
              <Text fw={700}>Buttons and status</Text>
              <Group gap="xs">
                <Button>Default button</Button>
                <Button variant="subtle">Subtle</Button>
                <Button variant="light">Light</Button>
                <Button variant="filled">Filled</Button>
                <Button color="red" variant="light">
                  Danger
                </Button>
              </Group>
              <Group gap="xs">
                <ActionIcon aria-label="Plain action">
                  <Settings size={17} />
                </ActionIcon>
                <ActionIcon aria-label="Filled action" variant="filled">
                  <Check size={17} />
                </ActionIcon>
              </Group>
              <Group gap="xs">
                <Badge>Neutral badge</Badge>
                <Badge className="kodex-ui-badge" data-tone="accent">
                  Accent badge
                </Badge>
                <Badge className="kodex-ui-badge" data-tone="danger">
                  Danger badge
                </Badge>
              </Group>
              <Alert icon={<Bell size={16} />} title="Workbench alert">
                Alert defaults follow semantic Kodex surfaces.
              </Alert>
              <Group align="center" gap="sm">
                <Loader size="sm" />
                <Progress aria-label="Plain progress" value={68} w={180} />
              </Group>
              <Skeleton aria-label="Plain skeleton" h={18} w="70%" />
            </Stack>
          </section>

          <section className="kodex-theme-workbench-section" aria-label="Data surfaces">
            <Stack gap="sm">
              <Text fw={700}>Data surfaces</Text>
              <Paper>
                <ScrollArea h={126}>
                  <Table stickyHeader>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Component</Table.Th>
                        <Table.Th>Status</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {["Table", "Paper", "ScrollArea", "Progress", "Skeleton"].map((name) => (
                        <Table.Tr key={name}>
                          <Table.Td>{name}</Table.Td>
                          <Table.Td>Defaulted</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </ScrollArea>
              </Paper>
            </Stack>
          </section>

          <section className="kodex-theme-workbench-section" aria-label="Tabs and segmented controls">
            <Stack gap="sm">
              <Text fw={700}>Navigation controls</Text>
              <Tabs defaultValue="activity">
                <Tabs.List>
                  <Tabs.Tab value="activity">Activity</Tabs.Tab>
                  <Tabs.Tab value="details">Details</Tabs.Tab>
                </Tabs.List>
                <Tabs.Panel value="activity">Recent turn activity</Tabs.Panel>
                <Tabs.Panel value="details">Thread settings</Tabs.Panel>
              </Tabs>
              <SegmentedControl
                aria-label="Preview mode"
                data={[
                  { label: "Preview", value: "preview" },
                  { label: "Source", value: "source" },
                ]}
                defaultValue="preview"
              />
            </Stack>
          </section>
        </div>
      </Stack>
    </Box>
  );
}
