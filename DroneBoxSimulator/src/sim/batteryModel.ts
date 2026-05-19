import { MAVIC_3T_SPECS } from './mavic3tSpecs';

export type BatteryModelInput = {
  batteryPercent: number;
  throttleLoad: number;
  dt: number;
};

export const updateBattery = ({ batteryPercent, throttleLoad, dt }: BatteryModelInput) => {
  const powerW =
    MAVIC_3T_SPECS.battery.hoverPowerW +
    throttleLoad * throttleLoad * (MAVIC_3T_SPECS.battery.maxPowerW - MAVIC_3T_SPECS.battery.hoverPowerW);
  const dischargeRate = (powerW / MAVIC_3T_SPECS.battery.capacityWh) * (100 / 3600);
  const nextBattery = Math.max(0, batteryPercent - dischargeRate * dt);
  const openCircuitVoltage =
    MAVIC_3T_SPECS.battery.emptyVoltage +
    (nextBattery / 100) * (MAVIC_3T_SPECS.battery.fullVoltage - MAVIC_3T_SPECS.battery.emptyVoltage);
  const currentA = powerW / Math.max(openCircuitVoltage, 1);
  const sag = currentA * MAVIC_3T_SPECS.battery.internalResistanceOhm;

  return {
    battery: nextBattery,
    voltage: Math.max(MAVIC_3T_SPECS.battery.emptyVoltage, openCircuitVoltage - sag)
  };
};
