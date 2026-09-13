import { Alert } from 'antd'

export default function CaHelp(): JSX.Element {
  return (
    <Alert
      type="info"
      showIcon
      message="配置図の読み方"
      description="同じ側の点間距離はχ²距離に対応します（2次元図は近似です）。異なる側の点同士の近さは距離として解釈できません。対称配置で「この属性の人はこの回答に最も近い」と自動解釈しないでください。"
    />
  )
}
