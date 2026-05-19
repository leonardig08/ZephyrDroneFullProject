export type UiSettings = {
  hudIntensity: number;
  showReticle: boolean;
  showTelemetry: boolean;
  showPidLog: boolean;
  showTrail: boolean;
  compactHud: boolean;
  ps4Enabled: boolean;
};

type SettingsPanelProps = {
  settings: UiSettings;
  onChange: (settings: UiSettings) => void;
};

export const SettingsPanel = ({ settings, onChange }: SettingsPanelProps) => {
  const patch = (partial: Partial<UiSettings>) => onChange({ ...settings, ...partial });

  return (
    <section className="settingsPanel">
      <div className="panelHeader">
        <div>
          <span>HUD</span>
          <strong>Settings</strong>
        </div>
        <small>Minimal</small>
      </div>

      <label className="rangeControl">
        <span>HUD glow</span>
        <input
          type="range"
          min="0.35"
          max="1"
          step="0.05"
          value={settings.hudIntensity}
          onChange={(event) => patch({ hudIntensity: Number(event.target.value) })}
        />
      </label>

      <div className="toggleGrid">
        <label>
          <input type="checkbox" checked={settings.showReticle} onChange={(event) => patch({ showReticle: event.target.checked })} />
          <span>Reticle</span>
        </label>
        <label>
          <input type="checkbox" checked={settings.showTelemetry} onChange={(event) => patch({ showTelemetry: event.target.checked })} />
          <span>Telemetry</span>
        </label>
        <label>
          <input type="checkbox" checked={settings.showPidLog} onChange={(event) => patch({ showPidLog: event.target.checked })} />
          <span>PID log</span>
        </label>
        <label>
          <input type="checkbox" checked={settings.showTrail} onChange={(event) => patch({ showTrail: event.target.checked })} />
          <span>Trail</span>
        </label>
        <label>
          <input type="checkbox" checked={settings.compactHud} onChange={(event) => patch({ compactHud: event.target.checked })} />
          <span>Compact</span>
        </label>
        <label>
          <input type="checkbox" checked={settings.ps4Enabled} onChange={(event) => patch({ ps4Enabled: event.target.checked })} />
          <span>PS4</span>
        </label>
      </div>
    </section>
  );
};
